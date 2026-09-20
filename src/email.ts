import { createTransport } from "nodemailer";
import { requireEnv } from "./env";

/**
 * The one thing `@hyperfixation/auth` cannot supply for an app: where an emailed code goes.
 *
 * `SMTP_URL` is mailpit in development (`smtp://localhost:1025`, inbox at :8025) and the
 * provider in production — one var, two destinations, which is why nothing here branches on
 * the environment. It takes two forms, told apart by the scheme rather than by a second var,
 * so `REQUIRED_ENV`, the three compose blocks and `.env.example` stay one line each:
 *
 * - `cloudflare-email://<api_token>@<account_id>` — Cloudflare Email Sending's REST API over
 *   HTTPS. Its SMTP endpoint speaks implicit TLS on 465 alone, and a host that blocks outbound
 *   465 (Hetzner does) cannot reach it at all, so the sending path has to be HTTPS there.
 * - anything else — nodemailer, exactly as before.
 *
 * The sender is built lazily for the same reason `src/web.ts` builds its pool lazily: `next
 * build` imports every route module, and `requireEnv` throws when there is no environment to
 * read.
 */
let send: Send | undefined;

interface Message {
  to: string;
  subject: string;
  text: string;
}

type Send = (message: Message) => Promise<void>;

const CLOUDFLARE_PREFIX = "cloudflare-email://";

const SEND_ENDPOINT = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`;

function sender(): Send {
  send ??= build(requireEnv("SMTP_URL"));
  return send;
}

function build(url: string): Send {
  if (!url.startsWith(CLOUDFLARE_PREFIX)) {
    const transport = createTransport(url);
    return async (message) => {
      await transport.sendMail({ from: requireEnv("EMAIL_FROM"), ...message });
    };
  }
  const { token, accountId } = parseCloudflareUrl(url);
  return (message) => postToCloudflare(token, accountId, message);
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
    throw new Error(`SMTP_URL is not a valid ${CLOUDFLARE_PREFIX} URL`);
  }
  const token = decodeURIComponent(parsed.username);
  const accountId = parsed.hostname;
  if (token === "" || accountId === "" || parsed.password !== "") {
    throw new Error(
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

async function postToCloudflare(
  token: string,
  accountId: string,
  message: Message,
): Promise<void> {
  const response = await fetch(SEND_ENDPOINT(accountId), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ from: requireEnv("EMAIL_FROM"), ...message }),
  });
  const envelope = (await response.json().catch(() => undefined)) as
    | CloudflareEnvelope
    | undefined;
  // `success: false` arrives with a 200 often enough that the status alone is not the answer.
  if (response.ok && envelope?.success === true) return;
  throw new Error(
    `Cloudflare Email Sending refused the message (HTTP ${response.status}): ${reason(envelope)}`,
  );
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
  await sender()({
    to: email,
    subject: type === "sign-in" ? "Your sign-in code" : "Your verification code",
    text: `${otp}\n\nThis code expires shortly. If you did not ask for it, ignore this email.`,
  });
}
