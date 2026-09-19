import type { ApprovalTypeDefinition } from "@hyperfixation/core";
import { z } from "zod";

/**
 * The `demoDraft` approval type: the shape of an outreach email, and the validators every
 * version of it is held to.
 *
 * The schema is not documentation. `approvals.decide` parses an **edited** draft against it
 * inside the locked transaction and refuses the whole batch if it fails, so this file is the
 * only thing standing between a text box in the inbox and a send — a decider who pastes a
 * tracking link or retargets the email at an address nobody vetted gets an
 * `ApprovalBatchRefused`, not a delivery. The draft flow parses its own model output against
 * the same schema before a human ever sees it, for the same reason from the other side.
 *
 * Phase 6's letter channel copies these validators, which is why they live in one object rather
 * than being spread through the flow that happens to use them first.
 */

/**
 * Who this app is allowed to write to. A constant rather than an env var on purpose: an
 * allowlist that a deploy can widen without a code review is not an allowlist. The demo's two
 * addresses are the ones `fixtures/sources/demoBusinesses.json` collects.
 */
export const CONTACT_ALLOWLIST = new Set([
  "owner@acme-roofing.example",
  "info@brightleaf.example",
]);

export const DEMO_DRAFT_TYPE = "demoDraft";

/** Long enough for a first email, short enough that a runaway generation is refused. */
const MAX_SUBJECT = 120;
const MAX_BODY = 1_200;

/** Deliberately broad: `example.com/x` has no scheme and is still a link a reader can follow. */
const URL_PATTERN = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|ai)\b/i;
/** Seven or more digits with the usual separators between them. */
const PHONE_PATTERN = /(?:\d[\s().+-]{0,2}){7,}/;
const EMAIL_PATTERN = /[^\s<>@]+@[^\s<>@]+\.[^\s<>@,;:]+/g;

function allowed(address: string): boolean {
  return CONTACT_ALLOWLIST.has(address.toLowerCase());
}

/** Every address the prose mentions has to be one this app is allowed to write to anyway. */
function onlyAllowlistedAddresses(text: string): boolean {
  return (text.match(EMAIL_PATTERN) ?? []).every(allowed);
}

export const demoDraftSchema = z.object({
  to: z
    .email()
    .refine(allowed, { error: "recipient is not in the contact allowlist" }),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SUBJECT)
    .refine((value) => !URL_PATTERN.test(value), { error: "subject contains a URL" }),
  body: z
    .string()
    .trim()
    .min(1)
    .max(MAX_BODY)
    .refine((value) => !URL_PATTERN.test(value), { error: "body contains a URL" })
    .refine((value) => !PHONE_PATTERN.test(value), { error: "body contains a phone number" })
    .refine(onlyAllowlistedAddresses, {
      error: "body names an email address outside the contact allowlist",
    }),
});

/** What the flow proposes, and what a decider's edit has to parse back into. */
export type DemoDraft = z.infer<typeof demoDraftSchema>;

export const demoDraftApproval: ApprovalTypeDefinition = {
  name: DEMO_DRAFT_TYPE,
  schema: demoDraftSchema,
};
