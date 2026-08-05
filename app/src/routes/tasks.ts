import type { Database } from "bun:sqlite";
import { getAllTasks, getTaskById, getInvoiceById, getMerchantById, hasActiveSubscription, freeDraftsRemaining } from "../db";
import { getStripeKey } from "../middleware/auth";
import { draftEmail } from "../pipeline/drafter";
import { reviewDraft } from "../pipeline/reviewer";
import { sendEmail, sendEmailForReal } from "../pipeline/sender";

export async function handleTasks(db: Database, req: Request, pathSuffix: string, merchantId: number): Promise<Response> {
  const headers = { "Content-Type": "application/json" };

  // GET /tasks — list all tasks
  if (req.method === "GET" && pathSuffix === "") {
    const tasks = getAllTasks(db, merchantId);
    return new Response(JSON.stringify(tasks), { status: 200, headers });
  }

  // POST /tasks/:id/process — run full pipeline for a task
  const processMatch = pathSuffix.match(/^\/(\d+)\/process$/);
  if (req.method === "POST" && processMatch) {
    const taskId = parseInt(processMatch[1], 10);
    const task = getTaskById(db, taskId);

    if (!task) {
      return new Response(JSON.stringify({ error: "Task not found" }), { status: 404, headers });
    }

    // Never process a task belonging to another merchant.
    const taskOwner = db.query("SELECT merchant_id FROM invoices WHERE id=?").get(task.invoice_id) as { merchant_id: number } | null;
    if (!taskOwner || taskOwner.merchant_id !== merchantId) {
      return new Response(JSON.stringify({ error: "Task not found" }), { status: 404, headers });
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
