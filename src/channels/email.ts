import type { ActionChannel } from "@hyperfixation/workflows";
import { createTransport, type Transporter } from "nodemailer";

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
 * `SMTP_URL` unset means nodemailer's `jsonTransport`: the message is serialized and returned
 * rather than delivered, so `pnpm test` and a laptop with nothing running send mail without a
 * server and without reaching anyone. It is deliberately the *unset* case and not a test flag —
 * the exit bar's mailpit and production's provider are both the same one var, set.
 *
 * The transport is built on first use for the same reason `src/email.ts`'s is: `next build`
 * imports every route module, and so this one, with no environment to read.
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
    const sent = await transporter().sendMail({
      from: process.env.EMAIL_FROM ?? LOCAL_SENDER,
      to: request.to,
      subject: request.subject,
      text: request.text,
      // Not an idempotency key — SMTP has none. It is the thread the `hf_action_log` row and a
      // bounce in the inbox are both findable by.
      headers: { "X-Hyperfixation-Action": dispatch.idempotencyKey },
    });
    // `envelope` is the one field both transports return; `accepted` is SMTP's alone.
    return { externalId: sent.messageId, response: { envelope: sent.envelope } };
  },
};
