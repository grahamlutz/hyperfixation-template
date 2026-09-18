"use client";
import { passkeyClient } from "@better-auth/passkey/client";
import { emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * The browser half of better-auth, and the only thing in this app that talks to
 * `/api/auth/*` directly.
 *
 * Its two plugins mirror the two the server factory carries, and they have to: the client
 * infers `signIn.emailOtp`, `emailOtp.sendVerificationOtp`, `passkey.addPasskey` and
 * `signIn.passkey` from the server plugins' own endpoint declarations, so a plugin present on
 * one side and not the other is a call that typechecks against nothing. `admin` and
 * `organization` have no client surface this app uses; the admin is server-rendered.
 *
 * No `baseURL`: every page that uses this is served from the same origin as the handler, and a
 * hard-coded one would be the app's public URL baked into a client bundle at build time.
 */
export const authClient = createAuthClient({
  plugins: [emailOTPClient(), passkeyClient()],
});
