import type { Database } from "bun:sqlite";
import { getAllTasks, getTaskById, getInvoiceById, getMerchantById, hasActiveSubscription, freeDraftsRemaining, isMerchantPaused, isMerchantDisconnected, logSend, createReminderTask, FREE_ALLOWANCE_MESSAGE } from "../db";
import { getStripeKey } from "../middleware/auth";
import { draftEmail, type EmailDraft } from "../pipeline/drafter";
import { reviewDraft } from "../pipeline/reviewer";
import { getLateFeeText } from "../pipeline/late-fee";
import { getEscalationStage } from "../pipeline/escalation";
import { sendEmail, sendEmailForReal } from "../pipeline/sender";

const headers = { "Content-Type": "application/json" };

const json404 = () => new Response(JSON.stringify({ error: "Task not found" }), { status: 404, headers });

/**
 * Resolve a task and verify it belongs to the authenticated merchant.
 * Returns null when the task is missing OR owned by another merchant
 * (both 404 — don't leak existence).
 */
function resolveOwnedTask(db: Database, taskId: number, merchantId: number): ReturnType<typeof getTaskById> {
  const task = getTaskById(db, taskId);
  if (!task) return null;
  const owner = db.query("SELECT merchant_id FROM invoices WHERE id=?").get(task.invoice_id) as { merchant_id: number } | null;
  if (!owner || owner.merchant_id !== merchantId) return null;
  return task;
}

/**
 * POST /tasks/resume — resume a reply-paused invoice's sequence.
 *
 * Body: `{ "invoice_id": 5 }` (the invoice's internal DB id — the same id the
 * tracked Reply-To `reply+5@replies.getcollectionscopilot.com` carries).
 *
 * Semantics:
 * - Clears invoices.reply_paused_at (the pause flag the inbound reply handler
 *   set; all Trust Modes pause on reply).
 * - Re-opens the sequence the way the watcher creates a task: when the
 *   invoice is still overdue and has no open (pending/drafted/reviewed) task,
 *   creates a fresh task at the invoice's CURRENT escalation stage and
 *   auto-drafts + reviews it, so it lands in the merchant's inbox
 *   ('reviewed', awaiting approval). It does NOT auto-send — resuming is an
 *   explicit act; the merchant's approve/process then applies Trust Mode as
 *   usual. Free merchants are subject to the same 5-draft allowance gate the
 *   watcher applies (no draft is consumed until the task is created).
 * - Does NOT clear invoices.reply_opt_out_at (a per-invoice opt-out set by
 *   the D1b opt_out classification is the customer's request and survives
 *   resume) and does NOT clear dispute/refund stops.
 * - Idempotent: resuming an invoice that is not reply-paused is a 200 no-op.
 *
 * Errors: 400 malformed body (missing/invalid invoice_id); 404 unknown or
 * not-owned invoice. Session-authenticated like every /tasks route.
 */
async function handleResume(db: Database, req: Request, merchantId: number): Promise<Response> {
  let body: { invoice_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
  }
  const raw = body.invoice_id;
  const invoiceId = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return new Response(
      JSON.stringify({ error: "invoice_id is required and must be a positive integer (the invoice's internal id from the reply+ tag)" }),
      { status: 400, headers }
    );
  }

  const invoice = getInvoiceById(db, invoiceId);
  if (!invoice || invoice.merchant_id !== merchantId) {
    return new Response(JSON.stringify({ error: "Invoice not found" }), { status: 404, headers });
  }

  const wasPaused = !!invoice.reply_paused_at;
  db.run("UPDATE invoices SET reply_paused_at=NULL WHERE id=?", [invoiceId]);
  if (!wasPaused) {
    console.log(`[tasks] merchant ${merchantId} resume invoice ${invoiceId} -> no-op (was not reply-paused)`);
    return new Response(JSON.stringify({
      ok: true, invoice_id: invoiceId, paused: false, task_created: false,
      message: "Invoice sequence was not paused — nothing to resume.",
    }), { status: 200, headers });
  }
  console.log(`[tasks] merchant ${merchantId} resume invoice ${invoiceId} -> pause cleared`);

  // Re-open the sequence. An open task already exists → just un-paused.
  const openTask = db.query(
    "SELECT id FROM reminder_tasks WHERE invoice_id=? AND status IN ('pending','drafted','reviewed')"
  ).get(invoiceId) as { id: number } | null;
  if (openTask) {
    return new Response(JSON.stringify({
      ok: true, invoice_id: invoiceId, paused: false, task_created: false,
      message: "Sequence resumed — an open reminder task was already in place.",
    }), { status: 200, headers });
  }

  // Only overdue invoices get a re-opened sequence (paid/void/open are done).
  if (invoice.status !== "overdue") {
    return new Response(JSON.stringify({
      ok: true, invoice_id: invoiceId, paused: false, task_created: false,
      message: `Sequence resumed — invoice is ${invoice.status}, no reminder re-opened.`,
    }), { status: 200, headers });
  }

  // Free-tier allowance gate (mirrors the watcher: task creation consumes a
  // draft; a free merchant with no allowance left gets no new task).
  if (!hasActiveSubscription(db, merchantId) && freeDraftsRemaining(db, merchantId) <= 0) {
    console.log(`[tasks] merchant ${merchantId} resume invoice ${invoiceId}: free draft allowance exhausted — no task created`);
    return new Response(JSON.stringify({
      ok: true, invoice_id: invoiceId, paused: false, task_created: false,
      message: "Sequence resumed, but no reminder re-opened: your free draft allowance is exhausted. Subscribe to keep sending reminders.",
    }), { status: 200, headers });
  }

  const timing = db.query("SELECT stage1_days, stage2_days FROM merchants WHERE id=?").get(merchantId) as { stage1_days: number; stage2_days: number } | null;
  const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / (1000 * 60 * 60 * 24)));
  const stage = getEscalationStage(daysOverdue, timing?.stage1_days ?? 6, timing?.stage2_days ?? 20);
  const taskId = createReminderTask(db, invoiceId, stage);

  // Auto-draft + review like the watcher; on failure leave the task 'pending'
  // (never fail the resume — the pause is already cleared).
  try {
    const task = getTaskById(db, taskId);
    if (task) {
      const draft = await draftEmail(task, invoice, getMerchantById(db, invoice.merchant_id)?.email, db);
      db.run("UPDATE reminder_tasks SET draft_subject=?, draft_body=?, status='drafted' WHERE id=?", [draft.subject, draft.body, taskId]);
      const review = reviewDraft(draft, invoice, {
        lateFeeText: getLateFeeText(db, invoice.merchant_id, invoice, task.stage),
      });
      db.run("UPDATE reminder_tasks SET reviewer_notes=?, status='reviewed' WHERE id=?", [JSON.stringify(review), taskId]);
    }
  } catch (err: unknown) {
    console.warn(`[tasks] resume auto-draft failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)} — task left pending`);
  }

  return new Response(JSON.stringify({
    ok: true, invoice_id: invoiceId, paused: false, task_created: true, task_id: taskId, stage,
    message: `Sequence resumed — reminder re-opened at stage ${stage} and drafted. Approve it to send.`,
  }), { status: 200, headers });
}

export async function handleTasks(db: Database, req: Request, pathSuffix: string, merchantId: number): Promise<Response> {
  // POST /tasks/resume — reply-pause resume (see handleResume).
  if (req.method === "POST" && pathSuffix === "/resume") {
    return handleResume(db, req, merchantId);
  }

  // GET /tasks — task inbox (pending/drafted/reviewed). Pass ?status=all to
  // include sent/cancelled history. Every task carries the draft text, subject,
  // stage, status, invoice facts, days_overdue and awaiting_approval.
  if (req.method === "GET" && pathSuffix === "") {
    const url = new URL(req.url);
    const includeAll = url.searchParams.get("status") === "all";
    const tasks = getAllTasks(db, merchantId, includeAll);
    return new Response(JSON.stringify(tasks), { status: 200, headers });
  }

  // POST /tasks/:id/approve — send the task's current draft through the exact
  // pipeline send path (sender.ts sendEmailForReal with paid-invoice, opt-out
  // and logging guards). Manual action: NOT blocked by merchant pause.
  const approveMatch = pathSuffix.match(/^\/(\d+)\/approve$/);
  if (req.method === "POST" && approveMatch) {
    const taskId = parseInt(approveMatch[1], 10);
    console.log(`[tasks] merchant ${merchantId} approve task ${taskId} -> start`);
    const task = resolveOwnedTask(db, taskId, merchantId);
    if (!task) {
      console.log(`[tasks] merchant ${merchantId} approve task ${taskId} -> 404 not_found`);
      return json404();
    }

    // Idempotency: a sent or cancelled task cannot be approved again
    // (double-approve is impossible — first approve flips status to 'sent').
    if (task.status === "sent" || task.status === "cancelled") {
      console.log(`[tasks] merchant ${merchantId} approve task ${taskId} -> 409 already_${task.status}`);
      return new Response(
        JSON.stringify({ error: "Task already sent or cancelled", currentStatus: task.status }),
        { status: 409, headers }
      );
    }

    // Free-tier sending (owner direction, rev 23): free merchants may approve
    // and send reminders within their 5-draft allowance — no payment required.
    // The allowance is consumed at DRAFT time (auto-draft at task creation, or
    // the inline draft below), never at send, so approving a task that already
    // carries a draft is always allowed and never decrements the counter. The
    // watcher blocks new task creation once the allowance is exhausted, so a
    // free merchant's sendable tasks are naturally capped at the allowance.
    // 402 (subscription_required) only when sending would require drafting a
    // NEW draft and no allowance remains.
    const subscribed = hasActiveSubscription(db, merchantId);
    const invoice = getInvoiceById(db, task.invoice_id);
    if (!invoice) {
      console.log(`[tasks] merchant ${merchantId} approve task ${taskId} -> 404 invoice_not_found`);
      return json404();
    }
    // Ensure there is a current draft to approve. Tasks that never went through
    // the pipeline (status 'pending') get drafted + reviewed inline first; the
    // draft steps mirror the /process pipeline (including the freemium counter,
    // which is charged once per drafted task — never on send).
    let draft: EmailDraft;
    if (task.status === "pending") {
      // Inline drafting consumes one free draft — gate free merchants on the
      // remaining allowance before drafting. Subscribed merchants unchanged.
      if (!subscribed && freeDraftsRemaining(db, merchantId) <= 0) {
        console.log(`[tasks] merchant ${merchantId} approve task ${taskId} -> 402 subscription_required (free draft allowance exhausted)`);
        return new Response(JSON.stringify({
          error: "subscription_required",
          message: FREE_ALLOWANCE_MESSAGE,
        }), { status: 402, headers });
      }
      draft = await draftEmail(task, invoice, getMerchantById(db, invoice.merchant_id)?.email, db);
      db.run("UPDATE reminder_tasks SET draft_subject=?, draft_body=?, status='drafted' WHERE id=?", [
        draft.subject, draft.body, taskId,
      ]);
      const review = reviewDraft(draft, invoice, {
        lateFeeText: getLateFeeText(db, invoice.merchant_id, invoice, task.stage),
      });
      db.run("UPDATE reminder_tasks SET reviewer_notes=?, status='reviewed' WHERE id=?", [
        JSON.stringify(review), taskId,
      ]);
    } else {
      draft = { subject: task.draft_subject || "", body: task.draft_body || "" };
      if (!draft.body) {
        // No usable draft on the row (anomalous — draft persists before the
        // status flips, but defend anyway). For a free merchant with no
        // allowance left this is also "beyond the free allowance", so the
        // upgrade prompt is the actionable response; otherwise keep the
        // existing defensive 400.
        if (!subscribed && freeDraftsRemaining(db, merchantId) <= 0) {
          console.log(`[tasks] merchant ${merchantId} approve task ${taskId} -> 402 subscription_required (free draft allowance exhausted)`);
          return new Response(JSON.stringify({
            error: "subscription_required",
            message: FREE_ALLOWANCE_MESSAGE,
          }), { status: 402, headers });
        }
        console.log(`[tasks] merchant ${merchantId} approve task ${taskId} -> 400 no_draft`);
        return new Response(
          JSON.stringify({ error: "Task has no draft to approve" }),
          { status: 400, headers }
        );
      }
    }

    // Send through the exact pipeline path (all guards inside sendEmailForReal).
    // sendEmailForReal sets status='sent' on success and leaves it unchanged on
    // failure, so a failed send keeps the task reviewed/drafted for retry.
    const customerEmail = invoice.customer_email;
    const sendResult = customerEmail && customerEmail !== ""
      ? await sendEmailForReal(db, task, draft, customerEmail)
      : sendEmail(db, task, draft);

    const updatedTask = getTaskById(db, taskId);

    if (sendResult.success) {
      console.log(`[tasks] merchant ${merchantId} approve task ${taskId} -> sent (via ${sendResult.provider || "stub"})`);
      return new Response(JSON.stringify({
        task: updatedTask,
        sent: true,
        sendResult,
        message: "Reminder approved and sent.",
      }), { status: 200, headers });
    }

    // Send failed (paid guard, opt-out guard, provider error) — keep the task
    // in place and return a clear error the UI can show.
    console.log(`[tasks] merchant ${merchantId} approve task ${taskId} -> error send_failed: ${sendResult.message}`);
    return new Response(JSON.stringify({
      error: "send_failed",
      message: sendResult.message,
      task: updatedTask,
      sendResult,
    }), { status: 502, headers });
  }

  // POST /tasks/:id/reject — merchant decided not to send this reminder.
  const rejectMatch = pathSuffix.match(/^\/(\d+)\/reject$/);
  if (req.method === "POST" && rejectMatch) {
    const taskId = parseInt(rejectMatch[1], 10);
    const task = resolveOwnedTask(db, taskId, merchantId);
    if (!task) return json404();

    if (task.status === "sent") {
      return new Response(
        JSON.stringify({ error: "Cannot reject a task that has already been sent", currentStatus: "sent" }),
        { status: 409, headers }
      );
    }

    if (task.status !== "cancelled") {
      db.run("UPDATE reminder_tasks SET status='cancelled' WHERE id=?", [taskId]);
      logSend(db, taskId, "skipped", "Reminder rejected by merchant — not sent");
      console.log(`[tasks] Merchant ${merchantId} rejected reminder task ${taskId} — cancelled`);
    }

    const updatedTask = getTaskById(db, taskId);
    return new Response(JSON.stringify({
      task: updatedTask,
      status: "cancelled",
      message: "Reminder rejected and cancelled.",
    }), { status: 200, headers });
  }

  // PUT /tasks/:id/draft — replace the task's draft body (merchant edit) and
  // set it back to 'reviewed' so it can be approved. The edited body is what
  // /approve sends.
  const draftMatch = pathSuffix.match(/^\/(\d+)\/draft$/);
  if (req.method === "PUT" && draftMatch) {
    const taskId = parseInt(draftMatch[1], 10);
    const task = resolveOwnedTask(db, taskId, merchantId);
    if (!task) return json404();

    if (task.status === "sent" || task.status === "cancelled") {
      return new Response(
        JSON.stringify({ error: "Cannot edit the draft of a sent or cancelled task", currentStatus: task.status }),
        { status: 409, headers }
      );
    }

    let body: { draft_body?: unknown; draft_subject?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }

    const draftBody = typeof body.draft_body === "string" ? body.draft_body.trim() : "";
    if (!draftBody) {
      return new Response(
        JSON.stringify({ error: "draft_body is required and must be non-empty" }),
        { status: 400, headers }
      );
    }
    if (draftBody.length > 10000) {
      return new Response(
        JSON.stringify({ error: "draft_body exceeds the 10,000 character limit" }),
        { status: 400, headers }
      );
    }

    const draftSubject = typeof body.draft_subject === "string" ? body.draft_subject.trim() : task.draft_subject;
    if (draftSubject.length > 500) {
      return new Response(
        JSON.stringify({ error: "draft_subject exceeds the 500 character limit" }),
        { status: 400, headers }
      );
    }

    db.run("UPDATE reminder_tasks SET draft_body=?, draft_subject=?, status='reviewed' WHERE id=?", [
      draftBody, draftSubject, taskId,
    ]);

    // Refresh reviewer_notes against the edited body so the notes stay truthful
    // for the UI. Not a gate: the merchant's explicit approval (/approve) is.
    const invoice = getInvoiceById(db, task.invoice_id);
    if (invoice) {
      const review = reviewDraft({ subject: draftSubject, body: draftBody }, invoice, {
        lateFeeText: getLateFeeText(db, invoice.merchant_id, invoice, task.stage),
      });
      db.run("UPDATE reminder_tasks SET reviewer_notes=? WHERE id=?", [JSON.stringify(review), taskId]);
    }

    const updatedTask = getTaskById(db, taskId);
    return new Response(JSON.stringify({
      task: updatedTask,
      message: "Draft updated. Ready for approval.",
    }), { status: 200, headers });
  }

  // POST /tasks/:id/process — run full pipeline for a task
  const processMatch = pathSuffix.match(/^\/(\d+)\/process$/);
  if (req.method === "POST" && processMatch) {
    const taskId = parseInt(processMatch[1], 10);
    const task = getTaskById(db, taskId);

    if (!task) {
      return json404();
    }

    // Never process a task belonging to another merchant.
    const taskOwner = db.query("SELECT merchant_id FROM invoices WHERE id=?").get(task.invoice_id) as { merchant_id: number } | null;
    if (!taskOwner || taskOwner.merchant_id !== merchantId) {
      return json404();
    }

    // Fix 2: Prevent double-processing. Since webhook-created tasks now arrive
    // auto-drafted ('reviewed', draft already on the row), /process accepts
    // pending/drafted/reviewed tasks: pending ones are drafted inline below,
    // drafted/reviewed ones reuse the draft already on the row. Only a sent or
    // cancelled task cannot be processed again.
    if (task.status === "sent" || task.status === "cancelled") {
      return new Response(
        JSON.stringify({ error: "Task already processed", currentStatus: task.status }),
        { status: 400, headers }
      );
    }

    const invoice = getInvoiceById(db, task.invoice_id);
    if (!invoice) {
      return new Response(JSON.stringify({ error: "Invoice not found" }), { status: 404, headers });
    }

    // Fix 1: Prevent processing paid/void invoices
    if (invoice.status === "paid" || invoice.status === "void") {
      return new Response(
        JSON.stringify({ error: "Cannot process: invoice is already paid" }),
        { status: 400, headers }
      );
    }

    // Reply-pause guard: a reply-paused invoice's sequence is stopped (the
    // reply handler cancels open tasks, and the watcher's stale guard skips
    // re-fired events) — defense-in-depth so no pipeline path can send for a
    // paused sequence even in a race. Resume via POST /tasks/resume first.
    if (invoice.reply_paused_at) {
      return new Response(
        JSON.stringify({ error: "Cannot process: the sequence is paused (customer reply). Resume it first." }),
        { status: 400, headers }
      );
    }

    // Reply opt-out guard (D1b): the customer asked to stop reminders about
    // THIS invoice (invoices.reply_opt_out_at). The opt-out survives resume
    // and blocks every pipeline send path for this invoice.
    if (invoice.reply_opt_out_at) {
      return new Response(
        JSON.stringify({ error: "Cannot process: this customer opted out of reminders for this invoice." }),
        { status: 400, headers }
      );
    }

    const subscribed = hasActiveSubscription(db, merchantId);
    const pipelineLog: string[] = [];

    // Step 1: Draft — only pending tasks need drafting. Tasks that arrived
    // auto-drafted (webhook-created, 'drafted'/'reviewed') reuse the draft on
    // the row — the freemium counter was already charged at creation, so it is
    // never charged twice for the same task.
    let draft: EmailDraft;
    if (task.status === "pending") {
      // Free merchants may create up to five drafts total. Drafting consumes
      // the allowance; SENDING never does (free tier sends within its draft
      // allowance, owner direction rev 23), so the allowance gate lives here —
      // once a draft exists, the send below is allowed.
      if (!subscribed && freeDraftsRemaining(db, merchantId) <= 0) {
        return new Response(JSON.stringify({
          error: "subscription_required",
          message: FREE_ALLOWANCE_MESSAGE,
        }), { status: 402, headers });
      }
      pipelineLog.push("Step 1: Drafting email...");
      draft = await draftEmail(task, invoice, getMerchantById(db, invoice.merchant_id)?.email, db);
      db.run("UPDATE reminder_tasks SET draft_subject=?, draft_body=?, status='drafted' WHERE id=?", [
        draft.subject,
        draft.body,
        taskId,
      ]);
      pipelineLog.push(`  Drafted: ${draft.subject}`);
    } else {
      draft = { subject: task.draft_subject || "", body: task.draft_body || "" };
      if (!draft.body) {
        // No usable draft on the row (anomalous — draft persists before the
        // status flips). Same rule as the pending path: a free merchant with
        // no allowance left cannot draft, so this is beyond the free allowance.
        if (!subscribed && freeDraftsRemaining(db, merchantId) <= 0) {
          return new Response(JSON.stringify({
            error: "subscription_required",
            message: FREE_ALLOWANCE_MESSAGE,
          }), { status: 402, headers });
        }
        return new Response(
          JSON.stringify({ error: "Task has no draft to process" }),
          { status: 400, headers }
        );
      }
      pipelineLog.push("Step 1: SKIPPED — draft already on task (auto-drafted at creation)");
    }

    // Step 2: Review
    pipelineLog.push("Step 2: Reviewing draft...");
    const review = reviewDraft(draft, invoice, {
      lateFeeText: getLateFeeText(db, invoice.merchant_id, invoice, task.stage),
    });
    db.run("UPDATE reminder_tasks SET reviewer_notes=?, status='reviewed' WHERE id=?", [
      JSON.stringify(review),
      taskId,
    ]);
    pipelineLog.push(`  Review result: ${review.approved ? "APPROVED" : "REJECTED"}`);
    if (review.issues.length > 0) {
      pipelineLog.push(`  Issues: ${review.issues.join("; ")}`);
    }

    // Step 3: Send — gated by review approval and Trust Mode
    if (review.approved) {
      // Fix 3: Enforce Trust Mode — per-invoice override wins over the
      // merchant-level default (null override falls back to merchant setting).
      const merchant = getMerchantById(db, invoice.merchant_id);
      const merchantTrustMode = merchant?.trust_mode || "draft";
      const trustMode = invoice.trust_mode_override ?? merchantTrustMode;

      if (trustMode === "draft") {
        // Draft mode: stop after review, do NOT send
        pipelineLog.push("Step 3: SKIPPED — Trust Mode is 'draft', email not sent. Awaiting merchant approval.");
        const updatedTask = getTaskById(db, taskId);
        return new Response(
          JSON.stringify({
            task: updatedTask,
            invoice,
            draft,
            review,
            pipelineLog,
            trustMode: "draft",
            message: "Email drafted and reviewed. Awaiting merchant approval before sending.",
          }),
          { status: 200, headers }
        );
      }

      if (trustMode === "semi") {
        if (task.stage >= 2) {
          // Semi-Auto: only auto-send stage 1; stage 2+ requires approval
          pipelineLog.push(`Step 3: SKIPPED — Trust Mode is 'semi' and stage is ${task.stage}. Requires merchant approval.`);
          const updatedTask = getTaskById(db, taskId);
          return new Response(
            JSON.stringify({
              task: updatedTask,
              invoice,
              draft,
              review,
              pipelineLog,
              trustMode: "semi",
              message: `Requires merchant approval for Stage ${task.stage}`,
            }),
            { status: 200, headers }
          );
        }
        // stage 1: fall through to send
      }

      // Pause/disconnect gate: while the merchant has collections paused OR
      // their Stripe account is disconnected, every AUTOMATIC send is skipped
      // (Semi-Auto stage 1 and Full Auto). The task stays in place (status
      // 'reviewed', not cancelled) so it resumes when unpaused/reconnected.
      // Manual actions (/approve, /summary/send) are NOT blocked by pause or
      // disconnection — a merchant can still fire a final reminder by hand.
      const paused = isMerchantPaused(db, invoice.merchant_id);
      const disconnected = isMerchantDisconnected(db, invoice.merchant_id);
      if (paused || disconnected) {
        const reason = disconnected
          ? "Stripe account disconnected"
          : "collections paused";
        pipelineLog.push(`Step 3: SKIPPED — ${reason}, email not sent. Automatic sends resume when reconnected/unpaused.`);
        console.log(`[pipeline] skipped: ${reason.toLowerCase()} (merchant ${invoice.merchant_id}, task ${taskId}, stage ${task.stage}, trustMode ${trustMode})`);
        logSend(db, taskId, "skipped", `${reason.toLowerCase()} — automatic send skipped (task kept for resume)`);
        const updatedTask = getTaskById(db, taskId);
        return new Response(
          JSON.stringify({
            task: updatedTask,
            invoice,
            draft,
            review,
            pipelineLog,
            trustMode,
            message: disconnected
              ? "Your Stripe account is disconnected — automatic sends are stopped. Reconnect your account to resume."
              : "Collections are paused — automatic send skipped. Resume in settings to continue.",
          }),
          { status: 200, headers }
        );
      }

      // Full Auto (or Semi stage 1): send. Sending is allowed for free
      // merchants too — within the 5-draft allowance. By this point the draft
      // exists on the task (auto-drafted at creation, or drafted inline in Step
      // 1 under the allowance gate), and the allowance was charged at drafting,
      // never at sending, so no further gate is needed: a free merchant's
      // sendable tasks are capped at the allowance by the watcher, and sending
      // never decrements the counter (no double-count). 'full' trust mode is
      // Pro-gated in /settings; free merchants in 'semi' auto-send only stage
      // 1 — both respect the allowance the same way.
      pipelineLog.push("Step 3: Sending email...");

      // Try real send first, fall back to stub
      let sendResult;
      const customerEmail = invoice.customer_email;
      if (customerEmail && customerEmail !== "") {
        sendResult = await sendEmailForReal(db, task, draft, customerEmail);
      } else {
        sendResult = sendEmail(db, task, draft);
      }
      pipelineLog.push(`  Send result: ${sendResult.message}${sendResult.provider ? ` (via ${sendResult.provider})` : ""}`);
    } else {
      pipelineLog.push("Step 3: SKIPPED — draft not approved, email not sent");
    }

    const updatedTask = getTaskById(db, taskId);

    return new Response(
      JSON.stringify({
        task: updatedTask,
        invoice,
        draft,
        review,
        pipelineLog,
      }),
      { status: 200, headers }
    );
  }

  return new Response("Not found", { status: 404 });
}
