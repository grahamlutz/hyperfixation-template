import { spawn, type ChildProcess } from "node:child_process";
import { cp } from "node:fs/promises";
import path from "node:path";

export interface RunningServer {
  baseUrl: string;
  stop(): Promise<void>;
}

/** Set to serve the deploy artifact instead of `pnpm dev`; see below. */
export const BUILD_ENV = "HF_E2E_BUILD";

/**
 * The app, served, for the e2e to drive.
 *
 * `pnpm dev` by default, because that is the exit bar's own spelling —
 * `hf new demo-app --local && pnpm dev` — and a proof that runs something else proves something
 * else. `HF_E2E_BUILD=1` serves the standalone build instead, which is what a deploy runs; both
 * pass, and running both is how a defect that lives in only one compilation shape gets caught.
 *
 * The port comes from `APP_URL` because it has to. better-auth checks the WebAuthn ceremony's
 * origin against the one the factory was given, and a passkey enrolled against an origin is
 * unusable against any other — so serving the app anywhere but its own `APP_URL` would fail the
 * enrolment this suite exists to prove.
 */
export async function startServer(): Promise<RunningServer> {
  const root = process.cwd();
  const appUrl = new URL(process.env.APP_URL ?? "http://localhost:3000");
  const built = process.env[BUILD_ENV] === "1";

  if (built) await buildStandalone(root);

  const child = built
    ? spawn(process.execPath, [".next/standalone/server.js"], {
        cwd: root,
        env: { ...process.env, HF_PROCESS: "web", PORT: appUrl.port, HOSTNAME: "127.0.0.1" },
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn("pnpm", ["dev", "--port", appUrl.port], {
        cwd: root,
        env: { ...process.env, HF_PROCESS: "web" },
        stdio: ["ignore", "pipe", "pipe"],
      });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  const baseUrl = appUrl.origin;
  await waitForReady(baseUrl, child);

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

async function buildStandalone(root: string): Promise<void> {
  await run("pnpm", ["exec", "next", "build"], root);
  // `output: 'standalone'` traces the server's own dependencies and nothing else; the client
  // chunks and `public/` are copied in by whoever deploys it. The sign-in form is a client
  // component, so without this the page renders and never hydrates.
  await cp(path.join(root, ".next/static"), path.join(root, ".next/standalone/.next/static"), {
    recursive: true,
  });
  await cp(path.join(root, "public"), path.join(root, ".next/standalone/public"), {
    recursive: true,
  });
}

async function waitForReady(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}`);
    try {
      // `/auth/sign-in` rather than `/`, which redirects into the guard: this only asks whether
      // the process is listening and rendering. In dev it is also the first compile.
      const response = await fetch(`${baseUrl}/auth/sign-in`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the server did not become ready at ${baseUrl}; is that port already in use?`);
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}
