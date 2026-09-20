import {
  createApprovalNotifier,
  type ApprovalMessage,
  type ApprovalNotice,
  type ApprovalNotifier,
  type StepContext,
} from "@hyperfixation/workflows";
import { sql } from "drizzle-orm";
import { sendMail } from "./email";
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
 * A ban the admin plugin still holds in force: `banned` set, and either no expiry or one that
 * has not passed. `ban_expires` in the past is a lapsed ban and the row keeps `banned` true
 * until better-auth next touches it, so the expiry has to be read alongside the flag.
 */
const BAN_IN_FORCE = sql`banned IS TRUE AND (ban_expires IS NULL OR ban_expires > now())`;

/**
 * The assignee, if the gate named one and they can still act; otherwise every admin who can.
 *
 * An `assigneeId` with no `hf_user` row notifies nobody rather than falling back to the admins:
 * a notice that quietly goes to somebody else than the human it was assigned to is worse than
 * the gap, which `createApprovalNotifier` warns about loudly. A *banned* assignee is the other
 * case — the row is there but its human is locked out of the link, so "the assignee else the
 * admins" is read as the admins rather than as a gate left waiting on nobody.
 */
export async function approvalRecipients(
  notice: ApprovalNotice,
  ctx: StepContext,
): Promise<string[]> {
  return ctx.tx(async (db) => {
    if (notice.assigneeId !== null) {
      const { rows } = await db.execute<{ email: string; banned: boolean }>(
        sql`SELECT email, ${BAN_IN_FORCE} AS banned FROM hf_user WHERE id = ${notice.assigneeId}`,
      );
      if (rows.length === 0) return [];
      if (!rows[0]!.banned) return [rows[0]!.email];
    }
    const { rows } = await db.execute<{ email: string }>(
      sql`SELECT email FROM hf_user WHERE role = 'admin' AND NOT (${BAN_IN_FORCE}) ORDER BY email`,
    );
    return rows.map((row) => row.email);
  });
}

/**
 * A notice goes out through `src/email.ts`'s one sender, which is what reads `SMTP_URL` and
 * picks the transport — a private one here is how a `cloudflare-email://` URL reached
 * nodemailer and killed the worker mid-gate.
 *
 * The sender is read with `process.env` and defaulted rather than through `requireEnv`: a
 * laptop with `SMTP_URL` unset serializes the notice instead of delivering it, so there is no
 * envelope for `EMAIL_FROM` to be the sender of.
 */
const LOCAL_SENDER = "approvals@localhost";

async function sendNotice(message: ApprovalMessage): Promise<void> {
  await sendMail({
    from: process.env.EMAIL_FROM ?? LOCAL_SENDER,
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
