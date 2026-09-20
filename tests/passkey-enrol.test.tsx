import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnrolAlert } from "../app/(auth)/auth/passkey/enrol-alert";
import { enrolFailure } from "../app/(auth)/auth/passkey/enrol-error";

/**
 * Which refusal the enrolment page is looking at, and what it then says.
 *
 * The case that matters is the one a real box produces: the authenticator already holds a
 * passkey for this account, which no retry can fix — so "Try again." is the wrong sentence and
 * the sign-in page is the right destination.
 */
describe("enrolFailure()", () => {
  it("reads the client's mapped code as already enrolled", () => {
    expect(
      enrolFailure({
        code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED",
        message: "Previously registered",
        status: 400,
      }),
    ).toBe("already-enrolled");
  });

  it("reads the server's code, the DOMException and the message the same way", () => {
    expect(enrolFailure({ code: "PREVIOUSLY_REGISTERED" })).toBe("already-enrolled");
    expect(enrolFailure({ name: "InvalidStateError", message: "" })).toBe("already-enrolled");
    expect(enrolFailure({ code: "UNKNOWN_ERROR", message: "Previously registered" })).toBe(
      "already-enrolled",
    );
  });

  it("leaves every other refusal generic", () => {
    expect(enrolFailure({ code: "ERROR_CEREMONY_ABORTED" })).toBe("refused");
    expect(enrolFailure({ code: "CHALLENGE_NOT_FOUND", message: "Challenge not found" })).toBe(
      "refused",
    );
    expect(enrolFailure({ status: 500 })).toBe("refused");
    expect(enrolFailure(null)).toBe("refused");
    expect(enrolFailure("Previously registered")).toBe("refused");
  });
});

describe("the enrolment alert", () => {
  it("sends an already-enrolled device to sign-in", () => {
    const html = renderToStaticMarkup(<EnrolAlert failure="already-enrolled" />);

    expect(html).toContain("This device already has a passkey for your account.");
    expect(html).toContain('href="/auth/sign-in"');
    expect(html).toContain('role="alert"');
  });

  it("keeps the generic sentence, and its absence of a link, for anything else", () => {
    for (const failure of ["refused", "not-promoted"] as const) {
      const html = renderToStaticMarkup(<EnrolAlert failure={failure} />);

      expect(html).not.toContain("/auth/sign-in");
      expect(html).toContain('role="alert"');
    }
    expect(renderToStaticMarkup(<EnrolAlert failure="refused" />)).toContain(
      "That authenticator was not enrolled.",
    );
  });

  it("renders nothing at all before anything has failed", () => {
    expect(renderToStaticMarkup(<EnrolAlert failure={null} />)).toBe("");
  });
});
