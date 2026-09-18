"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/auth-client";
import { promoteSession } from "./actions";

/**
 * The WebAuthn registration ceremony, then the promotion.
 *
 * `createSession` is deliberately left off. It would mint a session at
 * `/passkey/verify-registration`, which is not on `sessionFactorForPath`'s allowlist and would
 * therefore be stamped `code` — a strictly worse outcome than promoting the session that is
 * already here. Registration is not authentication, and the allowlist is right to say so.
 */
export function PasskeyForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enrol() {
    setBusy(true);
    setError(null);
    const result = await authClient.passkey.addPasskey({ name: "This device" });
    if (result?.error) {
      setBusy(false);
      setError("That authenticator was not enrolled. Try again.");
      return;
    }

    const promoted = await promoteSession();
    setBusy(false);
    if (!promoted) {
      setError("The passkey was enrolled but this session was not upgraded. Sign in with it.");
      return;
    }
    router.push("/w");
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={enrol} disabled={busy} style={BUTTON}>
        {busy ? "Waiting for your authenticator…" : "Add a passkey"}
      </button>
      {error === null ? null : (
        <p role="alert" style={{ color: "#b00020" }}>
          {error}
        </p>
      )}
    </>
  );
}

const BUTTON: React.CSSProperties = { padding: "0.5rem 1rem", font: "inherit", cursor: "pointer" };
