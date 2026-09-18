import { requireSession } from "@/auth";
import { PasskeyForm } from "./passkey-form";

/**
 * Step-up, and the only place a passkey is enrolled.
 *
 * `factor: 'code'` rather than the area's own bar: `/auth/*` already defaults to `code`, but
 * stating it here says why the page exists — it is the one route whose whole purpose is to be
 * reachable by a session that has not got the second factor yet. Without the guard the page
 * would render for a stranger and the enrolment would fail confusingly at the endpoint, which
 * requires a session of its own.
 */
export default async function PasskeyPage() {
  const session = await requireSession({ factor: "code", pathname: "/auth/passkey" });

  return (
    <>
      <h1>Add a passkey</h1>
      <p>
        Signed in as {session.user.email ?? session.user.id}. An emailed code is one factor —
        possession of an inbox — and it reaches this page and nothing else. A passkey on this
        device is what opens the rest of __APP_NAME__.
      </p>
      <PasskeyForm />
    </>
  );
}
