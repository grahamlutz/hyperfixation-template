/**
 * Which of the two things went wrong when `addPasskey` refused, and nothing else.
 *
 * A plain module beside the form for the same reason `decide-form.ts` is one: the branch is
 * worth testing without a browser or an authenticator, and the form should hold the markup
 * rather than the reasoning.
 *
 * The common refusal on a real box is not a failure at all: the authenticator already holds a
 * passkey for this account, so the browser refuses the ceremony with WebAuthn's
 * `InvalidStateError` — which `@better-auth/passkey` turns into
 * `ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED` on the client, and which is `PREVIOUSLY_REGISTERED`
 * if it ever arrives from the server instead. The `DOMException` name and the message are
 * checked too, because all three have been the same event wearing a different coat.
 */
export type EnrolFailure = "already-enrolled" | "refused";

const ALREADY_ENROLLED = /^(ERROR_AUTHENTICATOR_)?PREVIOUSLY_REGISTERED$|^InvalidStateError$/i;

export function enrolFailure(error: unknown): EnrolFailure {
  if (typeof error !== "object" || error === null) return "refused";
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  for (const field of [code, name]) {
    if (typeof field === "string" && ALREADY_ENROLLED.test(field)) return "already-enrolled";
  }
  // better-auth's own text for the mapped code, and the bare `DOMException` name when something
  // hands the ceremony's error through unmapped.
  return typeof message === "string" && /previously registered|InvalidStateError/i.test(message)
    ? "already-enrolled"
    : "refused";
}
