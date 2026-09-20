import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerificationOTP } from "../src/email";

/**
 * Which transport `SMTP_URL` selects, and what the Cloudflare one puts on the wire.
 *
 * Both halves are spies: nodemailer's is the path that already worked and is only asserted to
 * still be chosen, and `fetch` is mocked because the alternative is mailing someone. What is
 * worth holding is the shape of the request (Cloudflare's REST API takes flat `to`/`from`
 * strings, not addresses), that every refusal throws, and that none of those throws carries the
 * API token — an error reaches Sentry and the worker's log.
 */
const { createTransport, sendMail } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: "<id@test>" }));
  return { createTransport: vi.fn(() => ({ sendMail })), sendMail };
});

vi.mock("nodemailer", () => ({ createTransport }));

const TOKEN = "cf-token-NOT-A-REAL-ONE";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/send`;
const FROM = "codes@app.test";
const OTP: VerificationOTP = { email: "ada@test.example", otp: "123456", type: "sign-in" };

const MANAGED = ["SMTP_URL", "EMAIL_FROM"];
const saved = new Map<string, string | undefined>();
const fetchMock = vi.fn<typeof fetch>();

/** Re-imported per test: which transport was built is module state, and that is half the point. */
async function freshSend(): Promise<(otp: VerificationOTP) => Promise<void>> {
  vi.resetModules();
  return (await import("../src/email")).sendVerificationOTP;
}

function cloudflareReplies(status: number, body: unknown): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const DELIVERED = { success: true, errors: [], messages: [], result: { delivered: [OTP.email] } };

beforeEach(() => {
  for (const name of MANAGED) saved.set(name, process.env[name]);
  process.env.SMTP_URL = `cloudflare-email://${TOKEN}@${ACCOUNT}`;
  process.env.EMAIL_FROM = FROM;
  createTransport.mockClear();
  sendMail.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  vi.unstubAllGlobals();
});

describe("cloudflare-email:// SMTP_URL", () => {
  it("posts the code to the account's send endpoint with the token as a bearer", async () => {
    cloudflareReplies(200, DELIVERED);

    await (await freshSend())(OTP);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      from: FROM,
      to: OTP.email,
      subject: "Your sign-in code",
      text: expect.stringContaining(OTP.otp),
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("percent-decodes the token before sending it", async () => {
    process.env.SMTP_URL = `cloudflare-email://${encodeURIComponent("tok/with+odd chars")}@${ACCOUNT}`;
    cloudflareReplies(200, DELIVERED);

    await (await freshSend())(OTP);

    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({
      authorization: "Bearer tok/with+odd chars",
    });
  });

  it("throws on `success: false`, naming Cloudflare's code and message", async () => {
    cloudflareReplies(200, {
      success: false,
      errors: [{ code: 10001, message: "email.sending.error.invalid_request_schema" }],
    });

    await expect((await freshSend())(OTP)).rejects.toThrow(
      /10001 email\.sending\.error\.invalid_request_schema/,
    );
  });

  it("throws on a non-2xx, naming the status", async () => {
    cloudflareReplies(403, { success: false, errors: [{ code: 10000, message: "Unauthorized" }] });

    await expect((await freshSend())(OTP)).rejects.toThrow(/HTTP 403/);
  });

  it("throws on a non-2xx that carries no envelope at all", async () => {
    fetchMock.mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

    await expect((await freshSend())(OTP)).rejects.toThrow(/HTTP 502/);
  });

  it("never puts the token in the error", async () => {
    cloudflareReplies(403, { success: false, errors: [{ code: 10000, message: "Unauthorized" }] });

    const error = await (await freshSend())(OTP).catch((thrown: unknown) => thrown);

    expect(String(error)).not.toContain(TOKEN);
    expect((error as Error).stack ?? "").not.toContain(TOKEN);
  });

  it.each([
    ["no account id", `cloudflare-email://${TOKEN}`],
    ["no token", `cloudflare-email://@${ACCOUNT}`],
    ["neither", "cloudflare-email://"],
    ["a password where the account id belongs", `cloudflare-email://${TOKEN}:secret@${ACCOUNT}`],
  ])("refuses a URL with %s, without quoting it", async (_case, url) => {
    process.env.SMTP_URL = url;

    const error = await (await freshSend())(OTP).catch((thrown: unknown) => thrown);

    expect(String(error)).toContain("cloudflare-email://<api_token>@<account_id>");
    expect(String(error)).not.toContain(TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("every other SMTP_URL", () => {
  it("still goes through nodemailer", async () => {
    process.env.SMTP_URL = "smtp://localhost:1025";

    await (await freshSend())(OTP);

    expect(createTransport).toHaveBeenCalledExactlyOnceWith("smtp://localhost:1025");
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: FROM, to: OTP.email, subject: "Your sign-in code" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the transport", () => {
  /** `next build` imports every route module, and there is no environment at build time. */
  it("is built on first send and not at import", async () => {
    delete process.env.SMTP_URL;
    vi.resetModules();

    const { sendVerificationOTP } = await import("../src/email");
    expect(createTransport).not.toHaveBeenCalled();

    await expect(sendVerificationOTP(OTP)).rejects.toThrow(/SMTP_URL is unset/);
  });

  it("is built once across sends", async () => {
    process.env.SMTP_URL = "smtp://localhost:1025";

    const send = await freshSend();
    await send(OTP);
    await send({ ...OTP, type: "email-verification" });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});
