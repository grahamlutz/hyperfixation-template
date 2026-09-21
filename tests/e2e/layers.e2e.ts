import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openWithAuthenticator,
  signInAsMember,
  startHarness,
  type Harness,
} from "./harness";

/**
 * Next's module layers, against the production build: an authenticated page render and a server
 * action, in one process, in both orders, twice — and a server log with nothing in it.
 *
 * What this is here for. `next build --webpack` compiles a route's module graph once per layer:
 * the rsc layer a page renders in, and the server-action layer an action runs in. Both live in
 * one process, and `serverExternalPackages` keeps `@hyperfixation/workflows` — where the flow
 * registry is — a single module under both. So `src/hyperfixation.ts` and `src/flows/*` are
 * evaluated twice in one process, and every module-level registration in this app runs twice:
 * a deployed app died on `DuplicateFlow: a flow named "collectDemoSource" is already defined`
 * after a server action and the re-render that followed it. `defineFlow` is idempotent for an
 * identical re-definition now, which is core's half; this is the half that would notice if it
 * stopped being, or if a second registration of another kind acquired the same hazard.
 *
 * Why the log is the assertion. Both layers answer their requests before the second registration
 * is reached, so a re-registration that throws is a 500 on some *later* request or a line nobody
 * read — never the response in hand. `harness.output()` is every server process's own stdout and
 * stderr, which is where the failure is spelled.
 *
 * Why it is the built server and not `pnpm dev`. The layers are a property of the compilation:
 * `startHarness({ built: true })` serves `.next/standalone`, which is what a deploy runs, whether
 * or not `HF_E2E_BUILD` is set for the rest of `pnpm test:e2e`.
 *
 * It needs what the other two e2e suites need — the dev compose up and `hf up` once.
 */

/** Seeded rather than collected: what this suite drives is the two layers, not the loop. */
const NOTE_NAME = "e2e layers target";

let harness: Harness;
let context: Awaited<ReturnType<typeof openWithAuthenticator>>["context"];
let page: Awaited<ReturnType<typeof openWithAuthenticator>>["page"];
let recordId: string;
let recordPath: string;
/** The cookies the browser holds, for the requests this suite makes without it. */
let cookie: string;
/** The label form's server-action id, off the page the server rendered. */
let actionId: string;

beforeAll(async () => {
  harness = await startHarness({ built: true });
  recordId = await seedNote();
  recordPath = `/w/demoNote/${recordId}`;
  ({ context, page } = await openWithAuthenticator(harness));
  // The emailed code and the passkey, through the app's own screens: every request below is one
  // a signed-in member makes, and the guard in front of `/w` is not what is being tested here.
  await signInAsMember(harness, page);
  cookie = (await context.cookies())
    .map((each) => `${each.name}=${each.value}`)
    .join("; ");
  actionId = labelActionId(await serverHtml(recordPath));
}, 900_000);

afterAll(async () => {
  await context?.close();
  // The board suite reads unarchived rows and the draft flow picks the best-scoring one, so this
  // row is left the way every other suite's is: out of both.
  await harness?.pool.query("UPDATE demo_note SET archived_at = now() WHERE normalized_name = $1", [
    NOTE_NAME,
  ]);
  await harness?.stop();
});

describe("Next's module layers in one process", () => {
  it("renders a page, runs a server action and re-renders, twice, with a silent log", async () => {
    for (let round = 0; round < 2; round += 1) {
      await clearLabels();

      expect((await page.goto(`${harness.baseUrl}/w`))?.status()).toBe(200);
      expect((await page.goto(`${harness.baseUrl}${recordPath}`))?.status()).toBe(200);

      // The action, and the re-render Next performs after it in the same request: `revalidatePath`
      // in `addRecordLabel` is what makes the rsc layer run again off the action layer's reply.
      const [posted] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url() === `${harness.baseUrl}${recordPath}`,
        ),
        page.getByRole("button", { name: "Label up" }).click(),
      ]);
      expect(posted.status()).toBe(200);
      await page.getByText("up on record").first().waitFor({ state: "visible" });
    }

    expect(appFailures(harness.output())).toEqual([]);
  }, 900_000);

  it("runs a server action before any page render in the process, twice, with a silent log", async () => {
    // A fresh process, because which layer instantiates the app's graph *first* is a property of
    // the process and there is no asking a process that has already answered a render. Sign-in
    // and step-up are behind it: `/auth/*` reaches `src/auth.ts` and the pool, never the app.
    await harness.restart();

    for (let round = 0; round < 2; round += 1) {
      await clearLabels();

      const form = new FormData();
      form.set(`$ACTION_ID_${actionId}`, "");
      form.set("recordType", "demoNote");
      form.set("recordId", recordId);
      form.set("value", "up");
      const posted = await fetch(`${harness.baseUrl}${recordPath}`, {
        method: "POST",
        redirect: "manual",
        // A server action posted from a form nothing hydrated — the shape a browser with no
        // JavaScript sends, and the only one that reaches the action layer with no render before
        // it. Next refuses the request without a matching `origin`.
        headers: { cookie, origin: harness.baseUrl },
        body: form,
      });
      expect(posted.status).toBeLessThan(400);
      expect(posted.status).toBeGreaterThanOrEqual(200);

      const rendered = await fetch(`${harness.baseUrl}/w`, { headers: { cookie } });
      expect(rendered.status).toBe(200);
      // The label really was written: a 200 from an action that did nothing would prove nothing
      // about the layer it ran in.
      expect(await labelCount()).toBe(1);
    }

    expect(appFailures(harness.output())).toEqual([]);
  }, 900_000);
});

/**
 * Every line of the server's log that is a failure of the app's: a re-registration by name, and
 * anything Next reported as a throw. Returned rather than counted, because the line itself is the
 * whole of what a future occurrence leaves behind.
 */
function appFailures(log: string): string[] {
  return log.split("\n").filter((line) => /DuplicateFlow|(?:^|\s)Error:/.test(line));
}

/**
 * The id of the action behind the label form, out of the HTML the server rendered. Next writes
 * one hidden `$ACTION_ID_<id>` per form so a browser with no JavaScript can post it; this suite
 * uses it for the same reason that browser does.
 */
function labelActionId(html: string): string {
  for (const form of html.split("<form").slice(1)) {
    const body = form.split("</form>")[0] ?? "";
    if (!body.includes("Label up")) continue;
    const id = /name="\$ACTION_ID_([0-9a-f]+)"/.exec(body)?.[1];
    if (id !== undefined) return id;
  }
  throw new Error("no $ACTION_ID on the label form; did the form stop being a server action?");
}

async function serverHtml(path: string): Promise<string> {
  const response = await fetch(`${harness.baseUrl}${path}`, { headers: { cookie } });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.text();
}

/** `stage` is a registered one, so this row adds no column to the board `exit-bar.e2e.ts` reads. */
async function seedNote(): Promise<string> {
  const { rows } = await harness.pool.query<{ id: string }>(
    `INSERT INTO demo_note (normalized_name, body, contact_email, score, spec_version, stage)
     VALUES ($1, 'A record for the module-layer suite to label.', $2, 0.1, 1, 'scored')
     ON CONFLICT (normalized_name) DO UPDATE SET archived_at = NULL
     RETURNING id::text AS id`,
    [NOTE_NAME, "owner@acme-roofing.example"],
  );
  return rows[0]!.id;
}

/** `labels.add` is not an upsert, so each round starts from none of them. */
async function clearLabels(): Promise<void> {
  await harness.pool.query(
    "DELETE FROM hf_label WHERE record_type = 'demoNote' AND record_id = $1",
    [recordId],
  );
}

async function labelCount(): Promise<number> {
  const { rows } = await harness.pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM hf_label WHERE record_type = 'demoNote' AND record_id = $1",
    [recordId],
  );
  return rows[0]?.count ?? 0;
}
