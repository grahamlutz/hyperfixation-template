import {
  createApprovalNotifier,
  type ApprovalMessage,
  type ApprovalNotice,
  type ApprovalNotifier,
  type StepContext,
} from "@hyperfixation/workflows";
import { sql } from "drizzle-orm";
import { createTransport, type Transporter } from "nodemailer";
import { requireEnv } from "./env";

/**
 * Who hears about an approval this app opened, and how.
 *
 * `waitForApproval` calls this for every gate that has not been notified about yet, inside the
 * step's own transaction — so the recipient read goes through `ctx.tx` and is fenced by the
 * same `FOR SHARE` on `hf_run` as the rest of the step. No flow passes its own `notify`; the
 * worker's is the one every gate uses, which is why the rule lives here rather than in a flow.
 *
 * The link is the `/w/approvals/<id>` page the inbox serves, under `APP_URL` — the same origin
 * the session cookie belongs to, so the recipient lands signed in or on the sign-in form.
 */

/**
 * The assignee, if the gate named one; otherwise every admin.
 *
 * An `assigneeId` with no `hf_user` row notifies nobody rather than falling back to the admins:
 * a notice that quietly goes to somebody else than the human it was assigned to is worse than
 * the gap, which `createApprovalNotifier` warns about loudly.
 */
export async function approvalRecipients(
  notice: ApprovalNotice,
  ctx: StepContext,
): Promise<string[]> {
  return ctx.tx(async (db) => {
    const { rows } = await db.execute<{ email: string }>(
      notice.assigneeId === null
        ? sql`SELECT email FROM hf_user WHERE role = 'admin' ORDER BY email`
        : sql`SELECT email FROM hf_user WHERE id = ${notice.assigneeId}`,
    );
    return rows.map((row) => row.email);
  });
}

/**
 * The app's transport for a notice, built on first use — `worker.ts` is not the only importer
 * and there is no environment to read at import time.
 *
 * `SMTP_URL` unset is nodemailer's `jsonTransport`, for the reason `src/channels/email.ts`
 * gives at length: the message is serialized rather than delivered, so `pnpm test` and a laptop
 * with nothing running notify without a mail server and without reaching anyone.
 */
let transport: Transporter | undefined;

function transporter(): Transporter {
  const url = process.env.SMTP_URL;
  transport ??=
    url === undefined || url === ""
      ? createTransport({ jsonTransport: true })
      : createTransport(url);
  return transport;
}

async function sendNotice(message: ApprovalMessage): Promise<void> {
  await transporter().sendMail({
    from: process.env.EMAIL_FROM ?? "approvals@localhost",
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
}

/**
 * What `worker.ts` and `tests/worker-fixture.ts` hand `startWorker({ approvalNotifier })`.
 *
 * `send` is a parameter so a test can read the one message a gate produced; nothing but a test
 * passes one. `APP_URL` is read here rather than at module scope for the same reason the
 * transport is built lazily.
 */
export function approvalNotifier(
  send: (message: ApprovalMessage) => Promise<void> = sendNotice,
): ApprovalNotifier {
  return createApprovalNotifier({
    appUrl: requireEnv("APP_URL"),
    recipients: approvalRecipients,
    send,
  });
}
