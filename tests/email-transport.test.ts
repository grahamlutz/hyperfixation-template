import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ActionDispatch, ApprovalNotice, StepContext } from "@hyperfixation/workflows";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerificationOTP } from "../src/email";

/**
 * Which transport `SMTP_URL` selects, what the Cloudflare one puts on the wire, and that the
 * three senders in this app — the sign-in code, the approval notifier, the outreach channel —
 * are the same one. They were not: the notifier's own `createTransport(process.env.SMTP_URL)`
 * met a `cloudflare-email://` URL in production, threw a `TypeError` that quoted the URL, and
 * put the API token in the container log.
 *
 * Both halves are spies: nodemailer's is the path that already worked and is only asserted to
 * still be chosen, and `fetch` is mocked because the alternative is mailing someone. What is
 * worth holding is the shape of the request (Cloudflare's REST API takes a flat `from` and a
 * `to` that may be an array), that every refusal throws, and that no throw from any of the
 * three transports carries the URL or the token — an error reaches Sentry and the worker's log.
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

const MANAGED = ["SMTP_URL", "EMAIL_FROM", "APP_URL"];
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

describe("an unset SMTP_URL", () => {
  /**
   * The dev and CI case, and the one `tests/notify.test.ts`, `contract` and `draft-approval`
   * all run under: the message is serialized rather than delivered.
   */
  it("serializes the mail through nodemailer's jsonTransport", async () => {
    delete process.env.SMTP_URL;

    await (await freshSend())(OTP);

    expect(createTransport).toHaveBeenCalledExactlyOnceWith({ jsonTransport: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the transport", () => {
  /** `next build` imports every route module, and there is no environment at build time. */
  it("is built on first send and not at import", async () => {
    vi.resetModules();

    const { sendVerificationOTP } = await import("../src/email");
    process.env.SMTP_URL = "smtp://localhost:1025";
    expect(createTransport).not.toHaveBeenCalled();

    await sendVerificationOTP(OTP);

    expect(createTransport).toHaveBeenCalledExactlyOnceWith("smtp://localhost:1025");
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

const ADMINS = ["ada@test.example", "grace@test.example"];
const APP_URL = "https://workspace.test";

const NOTICE: ApprovalNotice = {
  approvalId: 7,
  runId: "run-1",
  key: "approve",
  type: "demoDraft",
  draft: {},
  assigneeId: null,
  recordType: null,
  recordId: null,
  expiresAt: null,
};

/**
 * `src/notify.ts`'s default send, reached the way the worker reaches it: the real notifier over
 * a stubbed step context, so the path under test is `createApprovalNotifier` → `sendNotice` →
 * the shared sender. Who the recipients are is `tests/notify.test.ts`'s claim, against a real
 * database; what is held here is only that the notice leaves through the one transport.
 */
async function notifyAdmins(): Promise<void> {
  vi.resetModules();
  const { approvalNotifier } = await import("../src/notify");
  await approvalNotifier()(NOTICE, stepContext());
}

function stepContext(): StepContext {
  const db = { execute: async () => ({ rows: ADMINS.map((email) => ({ email })) }) };
  return {
    runId: NOTICE.runId,
    attempt: 1,
    workflowId: "workflow-1",
    key: "approval:notify",
    tx: ((work: (handle: unknown) => Promise<unknown>) => work(db)) as StepContext["tx"],
  };
}

describe("the approval notifier", () => {
  it("sends the notice through the shared sender, both admins in one request", async () => {
    process.env.APP_URL = APP_URL;
    cloudflareReplies(200, DELIVERED);

    await notifyAdmins();

    // Cloudflare's `to` takes an array — one request for the list, not one per recipient.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body.to).toEqual(ADMINS);
    expect(body.from).toBe(FROM);
    expect(body.text).toContain(`${APP_URL}/w/approvals/${NOTICE.approvalId}`);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("goes through nodemailer when SMTP_URL is a transport URL", async () => {
    process.env.APP_URL = APP_URL;
    process.env.SMTP_URL = "smtp://localhost:1025";

    await notifyAdmins();

    expect(createTransport).toHaveBeenCalledExactlyOnceWith("smtp://localhost:1025");
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ADMINS }));
  });
});

const DISPATCH: ActionDispatch = {
  idempotencyKey: "run-1:draft:send",
  runId: "run-1",
  key: "draft:send",
  request: { to: "owner@acme.test", subject: "Quick question", text: "Hello." },
};

async function performSend(): Promise<unknown> {
  vi.resetModules();
  const { emailChannel } = await import("../src/channels/email");
  return emailChannel.send(DISPATCH);
}

describe("the outreach channel", () => {
  it("sends through the shared sender, carrying the action header", async () => {
    cloudflareReplies(200, DELIVERED);

    const result = await performSend();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: FROM,
      to: "owner@acme.test",
      subject: "Quick question",
      headers: { "X-Hyperfixation-Action": DISPATCH.idempotencyKey },
    });
    // The REST API returns no message id, so the row carries none rather than an undefined one.
    expect(result).toEqual({ response: { envelope: { from: FROM, to: "owner@acme.test" } } });
  });

  it("goes through nodemailer when SMTP_URL is a transport URL", async () => {
    process.env.SMTP_URL = "smtp://localhost:1025";

    const result = await performSend();

    expect(createTransport).toHaveBeenCalledExactlyOnceWith("smtp://localhost:1025");
    expect(result).toMatchObject({ externalId: "<id@test>" });
  });
});

/**
 * The production failure, per transport. A nodemailer throw quotes `SMTP_URL` in its own
 * message — the crash was `Cannot create property 'mailer' on string 'cloudflare-email://…'` —
 * and a provider's code is text this app did not write, so what is asserted is that neither
 * reaches the rethrow.
 */
const SECRET_URL = `smtp://user:${TOKEN}@mail.test:587`;
const LEAKY = `Cannot create property 'mailer' on string '${SECRET_URL}'`;

describe("a transport that throws", () => {
  it("names the smtp transport and the operation, never the URL", async () => {
    process.env.SMTP_URL = SECRET_URL;
    createTransport.mockImplementationOnce(() => {
      throw new TypeError(LEAKY);
    });

    const error = await (await freshSend())(OTP).catch((thrown: unknown) => thrown);

    expect((error as Error).message).toBe("smtp transport: build failed: TypeError");
    expectNoSecret(error);
  });

  it("names the json transport when a serialized send fails", async () => {
    delete process.env.SMTP_URL;
    sendMail.mockRejectedValueOnce(Object.assign(new Error(LEAKY), { code: "EENVELOPE" }));

    const error = await (await freshSend())(OTP).catch((thrown: unknown) => thrown);

    expect((error as Error).message).toBe("json transport: send failed: Error EENVELOPE");
    expectNoSecret(error);
  });

  it("names the cloudflare transport when the request itself fails", async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed for ${process.env.SMTP_URL}`));

    const error = await (await freshSend())(OTP).catch((thrown: unknown) => thrown);

    expect((error as Error).message).toBe("cloudflare transport: send failed: TypeError");
    expectNoSecret(error);
  });

  /** Belt and braces: a code that did carry the URL is redacted on the way out. */
  it("redacts the URL from a code it did not write", async () => {
    process.env.SMTP_URL = SECRET_URL;
    sendMail.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: SECRET_URL }));

    const error = await (await freshSend())(OTP).catch((thrown: unknown) => thrown);

    expect((error as Error).message).toContain("<redacted>");
    expectNoSecret(error);
  });
});

function expectNoSecret(error: unknown): void {
  for (const text of [String(error), (error as Error).stack ?? ""]) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET_URL);
  }
}

/**
 * The cheap guard against a fourth private transport: every sender in this app reads `SMTP_URL`
 * through `src/email.ts`, and a `createTransport` anywhere else is the bug this suite exists
 * for, back again.
 */
const SENDER = "src/email.ts";

describe("nodemailer", () => {
  it("is imported by the shared sender alone", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const importers = [...sources(root, "src"), "worker.ts"].filter((file) =>
      /createTransport|["']nodemailer["']/.test(readFileSync(`${root}${file}`, "utf8")),
    );

    expect(importers).toEqual([SENDER]);
  });
});

function sources(root: string, dir: string): string[] {
  return readdirSync(`${root}${dir}`, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(root, `${dir}/${entry.name}`)
      : entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
        ? [`${dir}/${entry.name}`]
        : [],
  );
}
