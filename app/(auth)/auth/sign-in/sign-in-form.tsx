"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/auth-client";

type Stage = "email" | "code";

/**
 * The emailed-code sign-in, and the passkey shortcut past it.
 *
 * Both calls are better-auth's own client actions, so the endpoints that mint the session are
 * the ones the session-factor policy names: `/sign-in/email-otp` stamps `code`, and
 * `/passkey/verify-authentication` — the one path on the allowlist — stamps `passkey`. This
 * file never states a factor; it only chooses which ceremony to run.
 *
 * The refusal text is deliberately the same whether the address has no user or the code is
 * wrong. `disableSignUp: true` means "no such user" is a real outcome here, and saying so would
 * turn this form into a way to ask whether an address has an account.
 */
export function SignInForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setBusy(false);
    if (failure) {
      setError("That code could not be sent. Check the address and try again.");
      return;
    }
    setStage("code");
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signIn.emailOtp({ email, otp: code });
    setBusy(false);
    if (failure) {
      setError("That code did not sign you in. Ask for a new one and try again.");
      return;
    }
    // A code-factor session reaches `/auth/*` and nowhere else, so the only useful next page is
    // the one that gets it the second factor.
    router.push("/auth/passkey");
    router.refresh();
  }

  async function signInWithPasskey() {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.passkey();
    setBusy(false);
    if (!result || result.error) {
      setError("That passkey did not sign you in.");
      return;
    }
    router.push("/w");
    router.refresh();
  }

  return (
    <>
      {stage === "email" ? (
        <form onSubmit={sendCode}>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="username webauthn"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={FIELD}
          />
          <button type="submit" disabled={busy} style={BUTTON}>
            {busy ? "Sending…" : "Email me a code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode}>
          <p>A code is on its way to {email}.</p>
          <label htmlFor="code">Sign-in code</label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
            style={FIELD}
          />
          <button type="submit" disabled={busy} style={BUTTON}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <button type="button" onClick={() => setStage("email")} style={LINK}>
            Use a different address
          </button>
        </form>
      )}

      <hr style={{ margin: "2rem 0", border: 0, borderTop: "1px solid currentColor", opacity: 0.2 }} />

      <button type="button" onClick={signInWithPasskey} disabled={busy} style={BUTTON}>
        Sign in with a passkey
      </button>

      {error === null ? null : (
        <p role="alert" style={{ color: "#b00020" }}>
          {error}
        </p>
      )}
    </>
  );
}

const FIELD: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.5rem",
  margin: "0.25rem 0 1rem",
  font: "inherit",
};

const BUTTON: React.CSSProperties = { padding: "0.5rem 1rem", font: "inherit", cursor: "pointer" };

const LINK: React.CSSProperties = {
  ...BUTTON,
  background: "none",
  border: 0,
  textDecoration: "underline",
};
