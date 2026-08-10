import type { Database } from "bun:sqlite";
import { getAllTasks, getTaskById, getInvoiceById, getMerchantById, hasActiveSubscription, freeDraftsRemaining, isMerchantPaused, isMerchantDisconnected, logSend } from "../db";
import { getStripeKey } from "../middleware/auth";
import { draftEmail, type EmailDraft } from "../pipeline/drafter";
import { reviewDraft } from "../pipeline/reviewer";
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

export async function handleTasks(db: Database, req: Request, pathSuffix: string, merchantId: number): Promise<Response> {
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
    const task = resolveOwnedTask(db, taskId, merchantId);
    if (!task) return json404();

    // Idempotency: a sent or cancelled task cannot be approved again
    // (double-approve is impossible — first approve flips status to 'sent').
    if (task.status === "sent" || task.status === "cancelled") {
      return new Response(
        JSON.stringify({ error: "Task already sent or cancelled", currentStatus: task.status }),
        { status: 409, headers }
      );
    }

    // Subscription gate — same 402 the pipeline returns at its send step:
    // free tier = no sending. The UI surfaces the upgrade prompt.
    if (!hasActiveSubscription(db, merchantId)) {
      return new Response(JSON.stringify({
        error: "subscription_required",
        message: "An active subscription is required to send reminders. Subscribe to continue.",
      }), { status: 402, headers });
    }

    const invoice = getInvoiceById(db, task.invoice_id);
    if (!invoice) return json404();

    // Ensure there is a current draft to approve. Tasks that never went through
    // the pipeline (status 'pending') get drafted + reviewed inline first; the
    // draft steps mirror the /process pipeline (including the freemium counter,
    // which only matters for free merchants — they never reach this point).
    let draft: EmailDraft;
    if (task.status === "pending") {
      draft = await draftEmail(task, invoice, getMerchantById(db, invoice.merchant_id)?.email, db);
      db.run("UPDATE reminder_tasks SET draft_subject=?, draft_body=?, status='drafted' WHERE id=?", [
        draft.subject, draft.body, taskId,
      ]);
      db.run("UPDATE merchants SET drafts_used = drafts_used + 1 WHERE id = ?", [invoice.merchant_id]);
      const review = reviewDraft(draft, invoice);
      db.run("UPDATE reminder_tasks SET reviewer_notes=?, status='reviewed' WHERE id=?", [
        JSON.stringify(review), taskId,
      ]);
    } else {
      draft = { subject: task.draft_subject || "", body: task.draft_body || "" };
      if (!draft.body) {
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
      return new Response(JSON.stringify({
        task: updatedTask,
        sent: true,
        sendResult,
        message: "Reminder approved and sent.",
      }), { status: 200, headers });
    }

    // Send failed (paid guard, opt-out guard, provider error) — keep the task
    // in place and return a clear error the UI can show.
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
      const review = reviewDraft({ subject: draftSubject, body: draftBody }, invoice);
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

    // Fix 2: Prevent double-processing
    if (task.status !== "pending") {
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

    const subscribed = hasActiveSubscription(db, merchantId);
    const pipelineLog: string[] = [];

    // Step 1: Draft — free merchants may create up to five drafts total.
    if (!subscribed && freeDraftsRemaining(db, merchantId) <= 0) {
      return new Response(JSON.stringify({
        error: "free_limit_reached",
        message: "You've used your 5 free drafts. Subscribe to keep drafting and start sending.",
      }), { status: 402, headers });
    }
    pipelineLog.push("Step 1: Drafting email...");
    const draft = await draftEmail(task, invoice, getMerchantById(db, invoice.merchant_id)?.email, db);
    db.run("UPDATE reminder_tasks SET draft_subject=?, draft_body=?, status='drafted' WHERE id=?", [
      draft.subject,
      draft.body,
      taskId,
    ]);
    // Durable freemium counter: one lifetime draft used per successful draft.
    // Only reached when the draft was actually written (draftEmail succeeded),
    // and only once — escalation re-runs create new tasks, not new counts.
    db.run("UPDATE merchants SET drafts_used = drafts_used + 1 WHERE id = ?", [invoice.merchant_id]);
    pipelineLog.push(`  Drafted: ${draft.subject}`);

    // Step 2: Review
    pipelineLog.push("Step 2: Reviewing draft...");
    const review = reviewDraft(draft, invoice);
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

      // Full Auto (or Semi stage 1): send. Sending is always subscriber-only.
      if (!subscribed) {
        return new Response(JSON.stringify({
          error: "subscription_required",
          message: "An active subscription is required to send reminders. Subscribe to continue.",
        }), { status: 402, headers });
      }
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
