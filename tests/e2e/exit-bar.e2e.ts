import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/load-env";
import { startServer, type RunningServer } from "./server";

/**
 * Phase 1's exit bar, driven end to end: sign in by emailed code, enrol a passkey through a
 * **software** authenticator, and get a 404 on `/admin` as a member.
 *
 * The passkey half is the reason this file exists at all. A WebAuthn ceremony needs an
 * authenticator, and until Chrome's DevTools `WebAuthn` domain there was no way to have one
 * without hardware — so "passkey enrolment through a software authenticator" was the one bullet
 * of chunk 14 that stayed manual. `WebAuthn.addVirtualAuthenticator` is a real CTAP2
 * authenticator inside the browser: the ceremony, the attestation and the credential are the
 * ones production runs, and only the hardware is simulated.
 *
 * It needs the dev compose up and the app migrated and bootstrapped — `hf dev --compose-only &&
 * hf migrate && hf bootstrap` — and it starts the server itself. See `pnpm test:e2e`.
 */
const MEMBER_EMAIL = "member@example.com";
const ADMIN_EMAIL = "admin@example.com";

let server: RunningServer;
let browser: Browser;
let pool: Pool;
let mailpit: string;

beforeAll(async () => {
  loadEnv(process.cwd());
  mailpit = mailpitUrl(required("SMTP_URL"));
  pool = new Pool({ connectionString: required("DATABASE_URL"), max: 2 });
  await seedMember();
  server = await startServer();
  browser = await chromium.launch();
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  await pool?.end();
});

describe("the Phase 1 exit bar", () => {
  it("signs a member in by emailed code, enrols a passkey, and 404s them on /admin", async () => {
    const { context, page } = await openWithAuthenticator();
    try {
      // A stranger is redirected rather than hidden from: the workspace has nothing to withhold
      // about its own existence, which is what makes the admin's 404 below a statement.
      await page.goto(`${server.baseUrl}/w`);
      expect(new URL(page.url()).pathname).toBe("/auth/sign-in");

      await signInByEmailedCode(page, MEMBER_EMAIL);
      // The emailed code is one factor, so it lands on step-up and nowhere else.
      expect(new URL(page.url()).pathname).toBe("/auth/passkey");

      // Holding only the code, and not the role either: the admin 404s before the factor is
      // even reached, which is the policy's order and not an accident of this member's state.
      expect(await status(page, "/admin")).toBe(404);

      // The workspace refuses the code factor too, but by sending them to step up.
      await page.goto(`${server.baseUrl}/w`);
      expect(new URL(page.url()).pathname).toBe("/auth/passkey");

      await enrolPasskey(page);
      expect(new URL(page.url()).pathname).toBe("/w");
      await page.getByText(`Signed in as ${MEMBER_EMAIL}`).waitFor({ state: "visible" });

      // The session really was promoted, rather than the page having been reached some other way.
      expect(await factorOf(MEMBER_EMAIL)).toBe("passkey");
      expect(await passkeyCount(MEMBER_EMAIL)).toBe(1);

      // The whole point: a member who has done everything right still does not learn that an
      // admin exists at this path.
      expect(await status(page, "/admin")).toBe(404);
      expect(await status(page, "/admin/users")).toBe(404);
    } finally {
      await context.close();
    }
  }, 300_000);

  it("lets the bootstrapped admin, with a passkey, read the users table", async () => {
    const { context, page } = await openWithAuthenticator();
    try {
      await page.goto(`${server.baseUrl}/auth/sign-in`);
      await signInByEmailedCode(page, ADMIN_EMAIL);
      // An admin holding only an emailed code gets the member's 404, not a step-up: the role
      // test runs first precisely so the two are indistinguishable.
      expect(await status(page, "/admin")).toBe(404);

      await enrolPasskey(page);
      expect(new URL(page.url()).pathname).toBe("/w");

      await page.goto(`${server.baseUrl}/admin/users`);
      await page.getByRole("link", { name: ADMIN_EMAIL }).waitFor({ state: "visible" });
      await page.getByRole("link", { name: MEMBER_EMAIL }).waitFor({ state: "visible" });
      // The list's columns are the ones `usersResource` declares, labelled off the metadata.
      await page.getByRole("columnheader", { name: "Role" }).waitFor({ state: "visible" });

      await page.getByRole("link", { name: MEMBER_EMAIL }).click();
      await page.getByText("Ban reason").waitFor({ state: "visible" });

      // A resource the admin does not serve answers exactly as a refusal does.
      expect(await status(page, "/admin/widgets")).toBe(404);
    } finally {
      await context.close();
    }
  }, 300_000);
});

/**
 * A CTAP2 platform authenticator with a resident key and user verification already satisfied —
 * the shape a laptop's own biometric sensor presents. `automaticPresenceSimulation` is what
 * stands in for the touch nobody is there to give.
 */
async function openWithAuthenticator(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
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

async function signInByEmailedCode(page: Page, email: string): Promise<void> {
  await page.goto(`${server.baseUrl}/auth/sign-in`);
  const since = Date.now();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const code = await codeFromMailpit(email, since);
  await page.getByLabel("Sign-in code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${server.baseUrl}/auth/passkey`);
}

async function enrolPasskey(page: Page): Promise<void> {
  await page.goto(`${server.baseUrl}/auth/passkey`);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.waitForURL(`${server.baseUrl}/w`, { timeout: 60_000 });
}

/** A plain fetch with the page's cookies, so a 404 is read as a status and not as a rendering. */
async function status(page: Page, path: string): Promise<number> {
  return page.evaluate(
    async (url: string) => (await fetch(url, { redirect: "manual" })).status,
    `${server.baseUrl}${path}`,
  );
}

/**
 * The code, out of mailpit's inbox. `since` is the instant the request was made: a second
 * sign-in for the same address would otherwise read the first attempt's code back.
 */
async function codeFromMailpit(email: string, since: number): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const search = new URL(`${mailpit}/api/v1/search`);
    search.searchParams.set("query", `to:${email}`);
    search.searchParams.set("limit", "5");
    const found = (await (await fetch(search)).json()) as {
      messages?: { ID: string; Created: string }[];
    };
    for (const message of found.messages ?? []) {
      if (Date.parse(message.Created) + 2_000 < since) continue;
      const body = (await (
        await fetch(`${mailpit}/api/v1/message/${message.ID}`)
      ).json()) as { Text?: string };
      const code = /\b\d{6}\b/.exec(body.Text ?? "")?.[0];
      if (code !== undefined) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no sign-in code reached ${email} within 30s; is mailpit up?`);
}

/** Seeded in SQL because there is no sign-up: a user exists because an admin put them there. */
async function seedMember(): Promise<void> {
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

async function factorOf(email: string): Promise<string | undefined> {
  const result = await pool.query<{ factor: string }>(
    `SELECT s.factor FROM hf_session s JOIN hf_user u ON u.id = s.user_id
     WHERE u.email = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [email],
  );
  return result.rows[0]?.factor;
}

async function passkeyCount(email: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM hf_passkey p JOIN hf_user u ON u.id = p.user_id
     WHERE u.email = $1`,
    [email],
  );
  return result.rows[0]?.count ?? 0;
}

/** mailpit's HTTP inbox is its SMTP port plus 7000, per `docker-compose.yml`. */
function mailpitUrl(smtpUrl: string): string {
  const url = new URL(smtpUrl);
  return `http://${url.hostname}:${Number(url.port || 1025) + 7000}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is unset; copy .env.example to .env and run hf migrate first`);
  }
  return value;
}
