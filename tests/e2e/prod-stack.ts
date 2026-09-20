import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bootstrapApp, newApp, statusTokenApp, TEMPLATE_MARKER } from "@hyperfixation/cli";
import { provisionRoles, type ProvisionedRoles } from "@hyperfixation/db/migrator";
import { ADMIN_URL } from "@hyperfixation/testing";
import { Client, Pool } from "pg";
import { REQUIRED_ENV, type RequiredEnv } from "../../src/env";

/**
 * The deployed stack, brought up for a test: a database and its roles, an app generated out of
 * this template, and `docker-compose.prod.yml` built and running against them.
 *
 * It is a module of its own because D4's redeploy suite is the second caller — it brings the
 * same stack up, patches a flow, and deploys it again under a new commit — so `deploy()` is a
 * method rather than something `start` does once.
 *
 * Two things here are not the deployed shape, and both are recorded rather than hidden:
 * `prod-compose.hostdb.yml` overlays the one route to a Postgres outside compose, and the app
 * is generated into a temporary directory because `docker-compose.prod.yml` in *this* checkout
 * would deploy an app called `__APP_NAME__` — a name `roleNames()` refuses, so `migrate` would
 * exit non-zero before anything else could be asserted. Generating is also the more honest
 * subject: what a deploy runs is a substituted app, never the template.
 */

const exec = promisify(execFile);

/**
 * The deploy file, plus the `host.docker.internal` overlay on the one platform that needs it.
 * See `prod-compose.hostdb.yml`: on a Mac the name resolves already and the overlay would
 * replace it with a gateway inside the VM.
 */
const COMPOSE_FILES: readonly string[] =
  process.platform === "linux"
    ? ["-f", "docker-compose.prod.yml", "-f", "tests/e2e/prod-compose.hostdb.yml"]
    : ["-f", "docker-compose.prod.yml"];

/** `hf up`'s own seed value; `bootstrapApp` has no default and refuses a non-positive one. */
const BOOTSTRAP_BUDGET_USD = "10";
const BOOTSTRAP_EMAIL = "admin@example.com";

/** Long enough for a cold `pnpm install` plus `next build` on a CI runner. */
const BUILD_TIMEOUT_MS = 900_000;
const WEB_READY_TIMEOUT_MS = 180_000;

export interface ProdStack {
  /** The generated app the image is built from. */
  appDir: string;
  appName: string;
  databaseName: string;
  /** Where the published `web` answers, and the `APP_URL` every container carries. */
  baseUrl: string;
  /** The commit the running stack was built with; `deploy()` replaces it. */
  sourceCommit: string;
  /** `/api/status`'s read token, provisioned by `hf status-token` after the first deploy. */
  readToken: string;
  /** The application role, from the host. Not the connection any container uses. */
  pool: Pool;
  /** `docker compose` against this stack's project and files, from the generated app. */
  compose(args: readonly string[]): Promise<string>;
  /** Rebuilds under `sourceCommit` and brings all three services up; waits for `web`. */
  deploy(sourceCommit: string): Promise<void>;
  /** The exit code of a service's container, or `null` while it is still running. */
  exitCodeOf(service: string): Promise<number | null>;
  logsOf(service: string): Promise<string>;
  /** Compose down, the database and its roles dropped, the generated app removed. */
  stop(): Promise<void>;
}

export interface ProdStackOptions {
  /** Defaults to a random 40-hex string; `startWorker()` refuses anything under 7 characters. */
  sourceCommit?: string;
  /** The published port, which is also the origin better-auth and the suite address. */
  port?: number;
}

/**
 * True when Docker is usable here. `pnpm test:prod` is opt-in for exactly this reason: the
 * contract suite needs a Postgres and nothing else, and CI's `image` job is where Docker lives.
 */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await exec("docker", ["info"], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

export async function startProdStack(options: ProdStackOptions = {}): Promise<ProdStack> {
  const suffix = randomBytes(4).toString("hex");
  const appName = `prod_${suffix}`;
  const databaseName = `hf_${appName}`;
  const port = options.port ?? 3000;
  const baseUrl = `http://localhost:${port}`;
  const project = `hf-prod-${suffix}`;

  const parent = await mkdtemp(path.join(tmpdir(), "hf-prod-"));
  let roles: ProvisionedRoles | undefined;
  let appDir: string | undefined;
  let pool: Pool | undefined;

  const dropDatabase = async (): Promise<void> => {
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
      for (const role of [roles?.migrator, roles?.application, roles?.readonly]) {
        if (role !== undefined) await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
      }
    });
  };

  try {
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    });
    roles = await provisionRoles(ADMIN_URL, { appName, databaseName });

    const generated = await newApp({
      name: appName,
      from: templateRoot(),
      into: parent,
      local: true,
      email: BOOTSTRAP_EMAIL,
    });
    appDir = generated.dir;

    const applicationUrl = roleUrl(ADMIN_URL, databaseName, roles.application, roles.applicationPassword);
    const migratorUrl = roleUrl(ADMIN_URL, databaseName, roles.migrator, roles.migratorPassword);
    pool = new Pool({ connectionString: applicationUrl, max: 2 });
    // `DROP DATABASE ... WITH (FORCE)` in the teardown terminates whatever is still connected,
    // and an idle pool client losing its socket is an unhandled `error` event otherwise.
    pool.on("error", () => undefined);

    const dir = appDir;
    const compose = async (args: readonly string[]): Promise<string> => {
      const { stdout } = await exec("docker", ["compose", "-p", project, ...COMPOSE_FILES, ...args], {
        cwd: dir,
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    };

    const stack: ProdStack = {
      appDir: dir,
      appName,
      databaseName,
      baseUrl,
      sourceCommit: "",
      readToken: "",
      pool,
      compose,
      deploy: async (sourceCommit: string) => {
        await writeEnvFile(dir, {
          image: `hf-prod-${suffix}`,
          sourceCommit,
          baseUrl,
          containerApplicationUrl: containerUrl(applicationUrl),
          containerMigratorUrl: containerUrl(migratorUrl),
        });
        await compose(["up", "-d", "--build", "--force-recreate"]);
        await waitForWeb(stack);
        stack.sourceCommit = sourceCommit;
      },
      exitCodeOf: (service) => exitCodeOf(compose, service),
      logsOf: (service) => compose(["logs", "--no-color", service]),
      // Each step runs whatever the ones before it did, so a failure anywhere still leaves no
      // container, no database and no role behind — and the first failure is what surfaces.
      stop: async () => {
        const failures: unknown[] = [];
        for (const step of [
          () => compose(["down", "-v", "--remove-orphans", "--rmi", "local", "-t", "10"]),
          () => pool?.end() ?? Promise.resolve(),
          dropDatabase,
          () => rm(parent, { recursive: true, force: true }),
        ]) {
          await step().catch((error: unknown) => failures.push(error));
        }
        if (failures.length > 0) throw failures[0];
      },
    };

    await stack.deploy(options.sourceCommit ?? randomBytes(20).toString("hex"));

    // Both connect as the application role, as `hf up` runs them: `bootstrap` seeds the
    // `hf_app_state` singleton `/api/status` reads and `status-token` fills its read hash,
    // which `statusTokenMatches` refuses every request against while it is null.
    await asApp(dir, applicationUrl, async () => {
      await bootstrapApp({ dir, email: BOOTSTRAP_EMAIL, budgetUsd: BOOTSTRAP_BUDGET_USD });
      const provisioned = await statusTokenApp({ dir, kinds: ["read"] });
      const read = provisioned.tokens.read;
      if (read === undefined) throw new Error("hf status-token provisioned no read token");
      stack.readToken = read;
    });

    return stack;
  } catch (error) {
    // Everything created above, in reverse, so a failure partway leaves no database, no role
    // and no container behind for the next run to collide with.
    if (appDir !== undefined) {
      await exec("docker", ["compose", "-p", project, "down", "-v", "--remove-orphans"], {
        cwd: appDir,
      }).catch(() => undefined);
    }
    await pool?.end().catch(() => undefined);
    await dropDatabase().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The template checkout this suite runs in. A generated app has no marker — `hf new` deletes it
 * — and nothing here can substitute one that is already substituted, so say so rather than
 * failing later inside `cp`.
 */
function templateRoot(): string {
  const root = process.cwd();
  if (!existsSync(path.join(root, TEMPLATE_MARKER))) {
    throw new Error(
      `${root} is not a template checkout (no ${TEMPLATE_MARKER}): the prod-compose suite ` +
        "generates the app it deploys, so it only runs where `hf new` would",
    );
  }
  return root;
}

/**
 * Every `REQUIRED_ENV` value, plus the two names `docker-compose.prod.yml` interpolates and the
 * two `hf bootstrap` reads. Typed as a total record on purpose: a var added to `REQUIRED_ENV`
 * and not here fails `tsc`, in the same spirit as `compose-envs.test.ts`.
 *
 * The Sentry, Langfuse and provider values are empty because every one of them is all-or-nothing
 * — an empty `SENTRY_DSN` is no Sentry at all, and `src/llm.ts` serves `fixtures/llm/` with no
 * provider key — which is what makes this stack cost nothing to bring up.
 */
async function writeEnvFile(
  dir: string,
  values: {
    image: string;
    sourceCommit: string;
    baseUrl: string;
    containerApplicationUrl: string;
    containerMigratorUrl: string;
  },
): Promise<void> {
  const env: Record<RequiredEnv, string> = {
    HF_PROCESS: "web",
    HF_BUILD_SHA: values.sourceCommit,
    DATABASE_URL: values.containerApplicationUrl,
    MIGRATOR_DATABASE_URL: values.containerMigratorUrl,
    APP_URL: values.baseUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    SMTP_URL: "smtp://host.docker.internal:1025",
    EMAIL_FROM: "prod-compose@example.com",
    SENTRY_DSN: "",
    LANGFUSE_BASE_URL: "",
    LANGFUSE_PUBLIC_KEY: "",
    LANGFUSE_SECRET_KEY: "",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
  };

  const lines = [
    ...REQUIRED_ENV.map((name) => `${name}=${env[name]}`),
    `DOCKER_IMAGE=${values.image}`,
    `SOURCE_COMMIT=${values.sourceCommit}`,
    `HF_BOOTSTRAP_EMAIL=${BOOTSTRAP_EMAIL}`,
    `HF_BOOTSTRAP_BUDGET_USD=${BOOTSTRAP_BUDGET_USD}`,
  ];
  await writeFile(path.join(dir, ".env"), `${lines.join("\n")}\n`);
}

/**
 * `hf bootstrap` and `hf status-token` read `.env` *under* `process.env`, and the file beside
 * the generated app holds the container's `DATABASE_URL` — `host.docker.internal`, which
 * resolves in a container and nowhere else. This is the host's spelling of the same role, for
 * the length of the two calls.
 */
async function asApp<T>(dir: string, applicationUrl: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = applicationUrl;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  }
}

interface ComposePsEntry {
  Service: string;
  State: string;
  ExitCode: number;
}

async function exitCodeOf(
  compose: (args: readonly string[]) => Promise<string>,
  service: string,
): Promise<number | null> {
  const stdout = await compose(["ps", "--all", "--format", "json"]);
  // Compose prints one object per line up to 2.20 and a single array after it, and which one a
  // runner has is not something this suite should depend on.
  const entries = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const parsed = JSON.parse(line) as ComposePsEntry | ComposePsEntry[];
      return Array.isArray(parsed) ? parsed : [parsed];
    });
  const found = entries.find((entry) => entry.Service === service);
  if (found === undefined) throw new Error(`no ${service} container: ${stdout}`);
  return found.State === "exited" ? found.ExitCode : null;
}

/**
 * `up -d` returns once the containers are started, and `migrate` gates the other two — so the
 * wait is for `web` answering, with `migrate`'s exit code checked first so a failed migration
 * is reported as itself rather than as a web that never came up.
 */
async function waitForWeb(stack: ProdStack): Promise<void> {
  const deadline = Date.now() + WEB_READY_TIMEOUT_MS;
  for (;;) {
    const migrate = await stack.exitCodeOf("migrate");
    if (migrate !== null && migrate !== 0) {
      throw new Error(`migrate exited ${migrate}:\n${await stack.logsOf("migrate")}`);
    }
    try {
      // Unauthorized is an answer: this only asks whether the web is serving.
      await fetch(`${stack.baseUrl}/api/status`);
      return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `web never answered at ${stack.baseUrl}:\n${await stack.logsOf("web")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function withAdmin(fn: (admin: Client) => Promise<void>): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await fn(admin);
  } finally {
    await admin.end();
  }
}

/** The same cluster the suite reaches at `localhost`, as a container has to spell it. */
function containerUrl(hostUrl: string): string {
  const url = new URL(hostUrl);
  url.hostname = "host.docker.internal";
  return url.toString();
}

function roleUrl(adminUrl: string, databaseName: string, role: string, password: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  url.username = role;
  url.password = password;
  return url.toString();
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
