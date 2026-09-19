import { describe, expect, it } from "vitest";
import { CONTACT_ALLOWLIST, demoDraftSchema } from "../src/approvals/demo-draft";

/**
 * The `demoDraft` validators, on their own and without a database.
 *
 * They are worth their own suite because they are the one thing in this app that stands between a
 * text box in the inbox and a send. `approvals.decide` runs `safeParse` on them inside its locked
 * transaction — so every case below is a case that refuses a real decision — and the draft flow
 * runs the same schema over its own model output before a human ever reads it.
 */

const allowed = [...CONTACT_ALLOWLIST][0]!;

function draft(over: Partial<Record<"to" | "subject" | "body", string>> = {}): unknown {
  return {
    to: allowed,
    subject: "A question about your north-side roofing work",
    body: "Hello,\n\nWe are putting together a short list of contractors. Reply if that is of interest.",
    ...over,
  };
}

describe("demoDraftSchema", () => {
  it("accepts a plain first email to an allowlisted contact", () => {
    const parsed = demoDraftSchema.safeParse(draft());

    expect(parsed.success).toBe(true);
    expect(parsed.data?.to).toBe(allowed);
  });

  it("refuses a recipient outside the allowlist", () => {
    const parsed = demoDraftSchema.safeParse(draft({ to: "someone@elsewhere.example" }));

    expect(parsed.success).toBe(false);
    expect(reasons(parsed.error)).toContain("recipient is not in the contact allowlist");
  });

  it("refuses an address that is not an address at all", () => {
    expect(demoDraftSchema.safeParse(draft({ to: "not-an-address" })).success).toBe(false);
  });

  it("refuses a URL in the subject or the body", () => {
    expect(demoDraftSchema.safeParse(draft({ subject: "See https://tracker.example" })).success).toBe(
      false,
    );
    expect(
      demoDraftSchema.safeParse(draft({ body: "Hello,\n\nRead more at offers.com today." })).success,
    ).toBe(false);
  });

  it("refuses a phone number in the body", () => {
    const parsed = demoDraftSchema.safeParse(draft({ body: "Hello,\n\nCall 555 010 2288." }));

    expect(parsed.success).toBe(false);
    expect(reasons(parsed.error)).toContain("body contains a phone number");
  });

  it("refuses an email address in the body that the allowlist does not name", () => {
    const parsed = demoDraftSchema.safeParse(draft({ body: "Hello,\n\nWrite to me@elsewhere.test." }));

    expect(parsed.success).toBe(false);
    expect(reasons(parsed.error)).toContain(
      "body names an email address outside the contact allowlist",
    );
  });

  it("allows the allowlisted address to appear in the body", () => {
    expect(demoDraftSchema.safeParse(draft({ body: `Hello,\n\nReplying to ${allowed} works.` })).success).toBe(
      true,
    );
  });

  it("refuses a body past the length cap", () => {
    expect(demoDraftSchema.safeParse(draft({ body: "word ".repeat(400) })).success).toBe(false);
  });

  it("refuses an empty subject", () => {
    expect(demoDraftSchema.safeParse(draft({ subject: "   " })).success).toBe(false);
  });
});

function reasons(error: { issues: readonly { message: string }[] } | undefined): string[] {
  return (error?.issues ?? []).map((issue) => issue.message);
}
