import type { EnrolFailure } from "./enrol-error";

/**
 * What each refusal says, and which of them offers a way out.
 *
 * Its own file rather than a block inside `passkey-form.tsx`, so `passkey-enrol.test.tsx` can
 * render it: the form reaches `@/auth-client`, which is better-auth's browser half and not
 * something a render test should have to stand up.
 *
 * An authenticator that already holds a passkey for this account cannot be enrolled again by
 * any number of retries, so that sentence names the only step that helps and links to it.
 */
export function EnrolAlert({ failure }: { failure: Failure | null }) {
  if (failure === null) return null;
  return (
    <p role="alert" style={{ color: "#b00020" }}>
      {MESSAGE[failure]}
      {failure === "already-enrolled" ? (
        <>
          {" "}
          <a href="/auth/sign-in">Go to sign-in</a>
        </>
      ) : null}
    </p>
  );
}

/** The enrolment's two refusals, and the one thing that can go wrong after it succeeded. */
export type Failure = EnrolFailure | "not-promoted";

const MESSAGE: Record<Failure, string> = {
  "already-enrolled":
    "This device already has a passkey for your account. Go back and use 'Sign in with a passkey'.",
  refused: "That authenticator was not enrolled. Try again.",
  "not-promoted": "The passkey was enrolled but this session was not upgraded. Sign in with it.",
};
