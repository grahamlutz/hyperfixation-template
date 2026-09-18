import { SignInForm } from "./sign-in-form";

/**
 * Where every refusal that is not the admin's lands. Two steps, one address: a code is sent to
 * an inbox, and the code signs in.
 *
 * There is no sign-up, here or anywhere — `disableSignUp: true` on the OTP plugin means a code
 * sent to an address with no `hf_user` row signs nobody in. The first admin comes from
 * `hf bootstrap`, on the box; everyone after that comes from an admin.
 *
 * The session this produces holds the `code` factor, which reaches `/auth/*` and nothing else.
 * `/auth/passkey` is the next step and the form sends you there.
 */
export default function SignInPage() {
  return (
    <>
      <h1>Sign in to __APP_NAME__</h1>
      <SignInForm />
    </>
  );
}
