import type { ActionChannel } from "@hyperfixation/workflows";
import { sendMail } from "../email";

/**
 * The one way an email leaves this app from inside a run.
 *
 * `dedupes: false`, and that is the load-bearing declaration here. SMTP has no idempotency key:
 * handing a server the same message twice delivers it twice, and nothing in the protocol lets
 * this channel ask whether the first one went out. So `actions.perform` never re-sends a row it
 * did not insert — a row left `started` by an attempt that is gone goes `uncertain`, an `hf_task`
 * asks a human whether the first send happened, and the run ends `failed` with
 * `ActionUncertain`. One send per row, ever, at the cost of a human deciding the unclear case.
 * A channel over a provider that *does* dedupe on a key (Postmark's `X-PM-Message-Id`, a
 * transactional API's own idempotency header) declares `true` and is simply re-sent instead.
 *
 * The send goes through `src/email.ts`'s one sender, which is where `SMTP_URL` picks the
 * transport — `jsonTransport` when it is unset, so `pnpm test` and a laptop with nothing
 * running send mail without a server and without reaching anyone; Cloudflare's REST API or a
 * nodemailer URL when it is set. Holding a transport of its own here is what made a
 * `cloudflare-email://` URL a `TypeError` in the worker rather than a send.
 */

/**
 * Read with `process.env` and defaulted rather than through `requireEnv`: the envelope sender
 * only reaches an SMTP server, and the run that would have needed one is the same run that found
 * `SMTP_URL` unset and serialized the message instead.
 */
const LOCAL_SENDER = "outreach@localhost";

export const EMAIL_CHANNEL_NAME = "email";

/** What `actions.perform`'s `request` carries on this channel. */
export interface EmailRequest {
  to: string;
  subject: string;
  text: string;
}

export const emailChannel: ActionChannel = {
  name: EMAIL_CHANNEL_NAME,
  dedupes: false,
  async send(dispatch) {
    const request = dispatch.request as EmailRequest;
    const sent = await sendMail({
      from: process.env.EMAIL_FROM ?? LOCAL_SENDER,
      to: request.to,
      subject: request.subject,
      text: request.text,
      // Not an idempotency key — SMTP has none. It is the thread the `hf_action_log` row and a
      // bounce in the inbox are both findable by.
      headers: { "X-Hyperfixation-Action": dispatch.idempotencyKey },
    });
    // `envelope` is the one field every transport reports; a message id is nodemailer's alone,
    // and the Cloudflare REST API returns none — hence the spread rather than an `undefined`.
    return {
      ...(sent.messageId === undefined ? {} : { externalId: sent.messageId }),
      response: { envelope: sent.envelope },
    };
  },
};
