import { createTransport, type Transporter } from "nodemailer";
import { requireEnv } from "./env";

/**
 * The one place in this app that sends mail. Everything that leaves it as an email — the
 * sign-in code, the worker's approval notices, the `email` action channel — goes through
 * `sendMail`, because the transport `SMTP_URL` names is a per-app decision and a second copy of
 * the decision is a transport that has not heard of the newest scheme. That is not theoretical:
 * a private `createTransport(process.env.SMTP_URL)` in the notifier handed nodemailer a
 * `cloudflare-email://` URL and the worker died on `Cannot create property 'mailer' on string`,
 * with the URL — and so the API token — in the message.
 *
 * `SMTP_URL` is mailpit in development (`smtp://localhost:1025`, inbox at :8025) and the
 * provider in production — one var, three destinations, which is why nothing here branches on
 * the environment. The scheme tells them apart rather than a second var, so `REQUIRED_ENV`, the
 * three compose blocks and `.env.example` stay one line each:
 *
 * - unset or empty — nodemailer's `jsonTransport`: the message is serialized rather than
 *   delivered, so `pnpm test` and a laptop with nothing running send mail without a server and
 *   without reaching anyone. Deliberately the *unset* case and not a test flag — the exit bar's
 *   mailpit and production's provider are both the same one var, set.
 * - `cloudflare-email://<api_token>@<account_id>` — Cloudflare Email Sending's REST API over
 *   HTTPS. Its SMTP endpoint speaks implicit TLS on 465 alone, and a host that blocks outbound
 *   465 (Hetzner does) cannot reach it at all, so the sending path has to be HTTPS there.
 * - anything else — a nodemailer transport URL.
 *
 * The sender is built lazily for the same reason `src/web.ts` builds its pool lazily: `next
 * build` imports every route module, and there is no environment to read at build time.
 */
let send: Send | undefined;

export interface Mail {
  /** Defaults to `EMAIL_FROM`. A caller with a local default of its own passes it. */
  from?: string;
  to: string | string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

/** The two fields every transport here reports; a channel writes them to `hf_action_log`. */
export interface Sent {
  messageId?: string;
  envelope?: unknown;
}

type Send = (mail: Mail) => Promise<Sent>;

/** What an error is allowed to name. Never the URL, which carries the credential. */
type Transport = "json" | "smtp" | "cloudflare";

const CLOUDFLARE_PREFIX = "cloudflare-email://";

const SEND_ENDPOINT = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`;

/**
 * Every failure a transport can produce, restated. A nodemailer throw quotes `SMTP_URL` in its
 * own message and a provider's body is text this app did not write, so nothing from either
 * reaches a log unchanged: the message names the transport, the operation and the underlying
 * status or code, and `scrub` is the second lock on the same door.
 */
export class MailError extends Error {
  readonly transport: Transport;

  constructor(transport: Transport, message: string) {
    super(scrub(`${transport} transport: ${message}`));
    this.name = "MailError";
    this.transport = transport;
  }
}

export async function sendMail(mail: Mail): Promise<Sent> {
  send ??= build(process.env.SMTP_URL);
  return send({ ...mail, from: mail.from ?? requireEnv("EMAIL_FROM") });
}

function build(url: string | undefined): Send {
  if (url === undefined || url === "") return nodemailer("json", { jsonTransport: true });
  if (!url.startsWith(CLOUDFLARE_PREFIX)) return nodemailer("smtp", url);
  const { token, accountId } = parseCloudflareUrl(url);
  return (mail) => attempt("cloudflare", "send", () => postToCloudflare(token, accountId, mail));
}

function nodemailer(transport: Transport, options: string | { jsonTransport: true }): Send {
  let built: Transporter | undefined;
  return async (mail) => {
    // Inside the send rather than beside it: `createTransport` is where nodemailer throws the
    // `TypeError` that quotes the URL, and that throw has to be restated like any other.
    const mailer = (built ??= await attempt(transport, "build", async () =>
      createTransport(options),
    ));
    const sent = await attempt(transport, "send", async () => mailer.sendMail(mail));
    return { messageId: sent.messageId, envelope: sent.envelope };
  };
}

async function attempt<T>(
  transport: Transport,
  operation: "build" | "send",
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MailError) throw error;
    throw new MailError(transport, `${operation} failed: ${describe(error)}`);
  }
}

/**
 * The name and code of a throw and nothing else — a message is provider text, and a `cause` or
 * a stack drags that text along with it, so neither is attached.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return "no error was reported";
  const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
  const reported = code ?? responseCode;
  return reported === undefined ? error.name : `${error.name} ${String(reported)}`;
}

/** Below this a "secret" is too short to redact without mangling the text it protects. */
const MIN_SECRET = 8;

/**
 * Removes `SMTP_URL` and its userinfo from a message on the way out. Nothing assembled above
 * puts them there; this is what makes that a property of the file rather than of every throw
 * site.
 */
function scrub(text: string): string {
  let scrubbed = text;
  for (const secret of secrets(process.env.SMTP_URL)) {
    if (secret.length >= MIN_SECRET) scrubbed = scrubbed.split(secret).join("<redacted>");
  }
  return scrubbed;
}

function secrets(url: string | undefined): string[] {
  if (url === undefined || url === "") return [];
  try {
    const { username, password } = new URL(url);
    const userinfo = [username, decodeURIComponent(username), password].filter(
      (part) => part !== "",
    );
    // A URL with no userinfo carries no credential, and redacting it would eat the scheme out
    // of the message that tells an operator what the scheme should look like.
    return userinfo.length === 0 ? [] : [url, ...userinfo];
  } catch {
    return [url];
  }
}

/**
 * The token is userinfo, so it is percent-decoded — a Cloudflare token is URL-safe today, but
 * an operator pasting one that is not would otherwise send a mangled credential and get a 403
 * with nothing to go on. Nothing that throws from here quotes the URL: it carries the token.
 */
function parseCloudflareUrl(url: string): { token: string; accountId: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MailError("cloudflare", `SMTP_URL is not a valid ${CLOUDFLARE_PREFIX} URL`);
  }
  const token = decodeURIComponent(parsed.username);
  const accountId = parsed.hostname;
  if (token === "" || accountId === "" || parsed.password !== "") {
    throw new MailError(
      "cloudflare",
      `SMTP_URL must be ${CLOUDFLARE_PREFIX}<api_token>@<account_id> — the API token as the ` +
        "user and the account id as the host, with no password",
    );
  }
  return { token, accountId };
}

interface CloudflareEnvelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
}

/**
 * `to` goes over as it was given: the REST API takes a flat address or an array of them, so an
 * approval told to every admin is one request with an array rather than one request each — its
 * limit is 50 addresses across `to`, `cc` and `bcc`, and nothing here fills a second field.
 * Named addresses and CC/BCC take a richer form this app does not use.
 */
async function postToCloudflare(token: string, accountId: string, mail: Mail): Promise<Sent> {
  const response = await fetch(SEND_ENDPOINT(accountId), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.headers === undefined ? {} : { headers: mail.headers }),
    }),
  });
  const envelope = (await response.json().catch(() => undefined)) as
    | CloudflareEnvelope
    | undefined;
  // `success: false` arrives with a 200 often enough that the status alone is not the answer.
  if (!response.ok || envelope?.success !== true) {
    throw new MailError(
      "cloudflare",
      `Cloudflare Email Sending refused the message (HTTP ${response.status}): ${reason(envelope)}`,
    );
  }
  // The REST API returns no message id; the envelope is what the transports have in common.
  return { envelope: { from: mail.from, to: mail.to } };
}

function reason(envelope: CloudflareEnvelope | undefined): string {
  const errors = envelope?.errors ?? [];
  if (errors.length === 0) return "no error was reported";
  return errors.map((error) => `${error.code ?? "?"} ${error.message ?? ""}`.trim()).join("; ");
}

export interface VerificationOTP {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}

/**
 * `emailOTP`'s `sendVerificationOTP`. It throws rather than swallowing: better-auth turns a
 * throw here into a failed `send-verification-otp` call, and a user told "check your email"
 * about a code that was never sent has no way to find that out.
 */
export async function sendVerificationOTP({ email, otp, type }: VerificationOTP): Promise<void> {
  await sendMail({
    to: email,
    subject: type === "sign-in" ? "Your sign-in code" : "Your verification code",
    text: `${otp}\n\nThis code expires shortly. If you did not ask for it, ignore this email.`,
  });
}
