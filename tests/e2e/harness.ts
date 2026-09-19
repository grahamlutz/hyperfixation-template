import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { loadEnv } from "../../src/load-env";
import { startServer, type RunningServer } from "./server";

/**
 * What both e2e files are: one browser, one served app, one pool, one mailpit, and the sign-in
 * ceremony that every screen behind `/w` needs first.
 *
 * It is a shared harness rather than a copied one because the second file's subject starts where
 * the first one's ends — a signed-in member looking at the inbox — and a second spelling of
 * "sign in by emailed code, then enrol a passkey" would be a second thing to keep true.
 */

export const MEMBER_EMAIL = "member@example.com";
export const ADMIN_EMAIL = "admin@example.com";

export interface Harness {
  baseUrl: string;
  /** mailpit's HTTP inbox, for the suites that read what the app sent. */
  mailpit: string;
  pool: Pool;
  browser: Browser;
  stop(): Promise<void>;
}

/**
 * Brings the app up for a suite. It needs the dev compose up and the app migrated and
 * bootstrapped — `hf up` once — and it starts the server itself. See `pnpm test:e2e`.
 */
export async function startHarness(): Promise<Harness> {
  loadEnv(process.cwd());
  const mailpit = mailpitUrl(required("SMTP_URL"));
  const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 2 });
  await seedMember(pool);
  let server: RunningServer | undefined;
  let browser: Browser | undefined;
  try {
    server = await startServer();
    browser = await chromium.launch();
  } catch (error) {
    await browser?.close();
    await server?.stop();
    await pool.end();
    throw error;
  }

  const running = server;
  const launched = browser;
  return {
    baseUrl: running.baseUrl,
    mailpit,
    pool,
    browser: launched,
    stop: async () => {
      await launched.close();
      await running.stop();
      await pool.end();
    },
  };
}

/**
 * A CTAP2 platform authenticator with a resident key and user verification already satisfied —
 * the shape a laptop's own biometric sensor presents. `automaticPresenceSimulation` is what
 * stands in for the touch nobody is there to give.
 */
export async function openWithAuthenticator(
  harness: Harness,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await harness.browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page };
}

export async function signInByEmailedCode(
  harness: Harness,
  page: Page,
  email: string,
): Promise<void> {
  await page.goto(`${harness.baseUrl}/auth/sign-in`);
  const since = Date.now();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const code = await codeFromMailpit(harness, email, since);
  await page.getByLabel("Sign-in code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${harness.baseUrl}/auth/passkey`);
}

export async function enrolPasskey(harness: Harness, page: Page): Promise<void> {
  await page.goto(`${harness.baseUrl}/auth/passkey`);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.waitForURL(`${harness.baseUrl}/w`, { timeout: 60_000 });
}

/** Signs in and steps up in one go, which is what every screen behind `/w` needs first. */
export async function signInAsMember(harness: Harness, page: Page): Promise<void> {
  await signInByEmailedCode(harness, page, MEMBER_EMAIL);
  await enrolPasskey(harness, page);
}

/** A plain fetch with the page's cookies, so a 404 is read as a status and not as a rendering. */
export async function status(harness: Harness, page: Page, path: string): Promise<number> {
  return page.evaluate(
    async (url: string) => (await fetch(url, { redirect: "manual" })).status,
    `${harness.baseUrl}${path}`,
  );
}

/**
 * The code, out of mailpit's inbox. `since` is the instant the request was made: a second
 * sign-in for the same address would otherwise read the first attempt's code back.
 */
export async function codeFromMailpit(
  harness: Harness,
  email: string,
  since: number,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const message of await searchMailpit(harness, email)) {
      if (Date.parse(message.Created) + 2_000 < since) continue;
      const code = /\b\d{6}\b/.exec(await mailpitText(harness, message.ID))?.[0];
      if (code !== undefined) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no sign-in code reached ${email} within 30s; is mailpit up?`);
}

/**
 * Every message to `email` whose body carries `link`, out of mailpit's inbox. The link is the
 * approval's own id, so a message from an earlier run of this suite cannot be one of them —
 * which is what makes the count an assertion rather than a sighting.
 */
export async function noticesFromMailpit(
  harness: Harness,
  email: string,
  link: string,
): Promise<{ subject: string }[]> {
  const carrying: { subject: string }[] = [];
  for (const message of await searchMailpit(harness, email)) {
    if ((await mailpitText(harness, message.ID)).includes(link)) {
      carrying.push({ subject: message.Subject });
    }
  }
  return carrying;
}

/**
 * The subjects of every message to `email` that mailpit received after `since`. mailpit is
 * shared with whatever else is pointed at it, so the instant is the whole of the filter: the
 * mail a suite is asserting on is the mail that arrived while it was running.
 */
export async function subjectsFromMailpit(
  harness: Harness,
  email: string,
  since: number,
  expected: number,
  timeoutMs = 60_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const subjects = (await searchMailpit(harness, email))
      .filter((message) => Date.parse(message.Created) + 2_000 >= since)
      .map((message) => message.Subject);
    if (subjects.length >= expected || Date.now() > deadline) return subjects;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  Created: string;
}

async function searchMailpit(harness: Harness, email: string): Promise<MailpitMessage[]> {
  const search = new URL(`${harness.mailpit}/api/v1/search`);
  search.searchParams.set("query", `to:${email}`);
  search.searchParams.set("limit", "100");
  const found = (await (await fetch(search)).json()) as { messages?: MailpitMessage[] };
  return found.messages ?? [];
}

async function mailpitText(harness: Harness, id: string): Promise<string> {
  const body = (await (await fetch(`${harness.mailpit}/api/v1/message/${id}`)).json()) as {
    Text?: string;
  };
  return body.Text ?? "";
}

/** Seeded in SQL because there is no sign-up: a user exists because an admin put them there. */
async function seedMember(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO hf_user (id, name, email, email_verified, role)
     VALUES ($1, 'Demo Member', $2, true, 'member')
     ON CONFLICT (email) DO UPDATE SET role = 'member', banned = NULL`,
    [randomUUID(), MEMBER_EMAIL],
  );
  await pool.query(
    `DELETE FROM hf_session WHERE user_id IN (SELECT id FROM hf_user WHERE email = ANY($1::text[]))`,
    [[MEMBER_EMAIL, ADMIN_EMAIL]],
  );
  await pool.query(
    `DELETE FROM hf_passkey WHERE user_id IN (SELECT id FROM hf_user WHERE email = ANY($1::text[]))`,
    [[MEMBER_EMAIL, ADMIN_EMAIL]],
  );
}

/** The box the inbox renders for one approval's subject, which is also what an edit types into. */
export function subjectBox(page: Page, approvalId: number) {
  return page.locator(`[name="edit:${approvalId}:subject"]`);
}

export async function waitForRunStatus(
  harness: Harness,
  runId: string,
  status: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await harness.pool.query<{ status: string; error: string | null }>(
      "SELECT status, error FROM hf_run WHERE run_id = $1",
      [runId],
    );
    if (rows[0]?.status === status) return;
    if (rows[0]?.status === "failed" || Date.now() > deadline) {
      throw new Error(
        `run ${runId} is ${rows[0]?.status ?? "missing"} rather than ${status}: ` +
          `${rows[0]?.error ?? "no error"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The run resumes on its own clock, so the page is asked again until its writes are there. */
export async function reloadUntil(
  harness: Harness,
  page: Page,
  path: string,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    await page.goto(`${harness.baseUrl}${path}`);
    if ((await page.getByText(text).count()) > 0) return;
    if (Date.now() > deadline) throw new Error(`"${text}" never appeared on ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** mailpit's HTTP inbox is its SMTP port plus 7000, per `docker-compose.yml`. */
function mailpitUrl(smtpUrl: string): string {
  const url = new URL(smtpUrl);
  return `http://${url.hostname}:${Number(url.port || 1025) + 7000}`;
}

export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is unset; copy .env.example to .env and run hf migrate first`);
  }
  return value;
}
