import { createTransport, type Transporter } from "nodemailer";
import { requireEnv } from "./env";

/**
 * The one thing `@hyperfixation/auth` cannot supply for an app: where an emailed code goes.
 *
 * `SMTP_URL` is mailpit in development (`smtp://localhost:1025`, inbox at :8025) and the
 * provider in production — one var, two destinations, which is why nothing here branches on
 * the environment. The transport is built lazily for the same reason `src/web.ts` builds its
 * pool lazily: `next build` imports every route module, and `requireEnv` throws when there is
 * no environment to read.
 */
let transport: Transporter | undefined;

function transporter(): Transporter {
  transport ??= createTransport(requireEnv("SMTP_URL"));
  return transport;
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
  await transporter().sendMail({
    from: requireEnv("EMAIL_FROM"),
    to: email,
    subject: type === "sign-in" ? "Your sign-in code" : "Your verification code",
    text: `${otp}\n\nThis code expires shortly. If you did not ask for it, ignore this email.`,
  });
}
