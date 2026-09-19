# __APP_NAME__

A Hyperfixation app. The machinery — runs, steps, the ledger, approvals, actions, the admin,
auth, the workspace UI — lives in `@hyperfixation/*` and is upgraded, never edited. This repo
is what is specific to this app: its flows, its record tables, its prompts, its fixtures.

## The one rule everything else follows from

**A run crosses a deploy by restarting, not by resuming.** Every workflow belongs to the
`applicationVersion` it started under; a redeploy bumps `hf_run.attempt`, gives the run a new
fencing token, and runs it again from the top on the new code. So:

- Every step is keyed, and every effect a step has is keyed by that key — that is what makes
  the second attempt a no-op instead of a second charge or a second send.
- Every database write from a flow goes through `ctx.tx`. It is the only handle a step body
  gets, and the step pool refuses a write issued any other way with `UnfencedWrite` — from a
  timer, from a listener, from a helper that imported a raw handle. This is enforcement, not
  convention.
- `DBOS.patch`, `recv`/`send`, `getEvent`/`setEvent` and `sendInTransaction` are banned by
  ESLint. Each one carries a workflow across a version boundary; each one silently breaks the
  above.

`tests/flow-restart.test.ts` is where all of this is checked, for every registered flow, on
every commit. If a change makes it red, the change is wrong far more often than the test is.

## Layout

| Path | What lives there |
|---|---|
| `src/hyperfixation.ts` | `defineApp` — the registry of everything this app has |
| `src/flows/` | Flows. `pnpm gen` scaffolds one and registers it |
| `src/sources/` | `defineSource` — what a collect flow streams into `hf_source_record` |
| `src/resolvers/` | `defineResolver` — which record a loaded row is, and how to create or update it |
| `src/specs/` / `src/scorers/` | `defineSpec` and `defineScorer` — the criteria, and the call that judges against them |
| `src/llm.ts` | The app's one `createLlm`: the provider registry and `prompts/` |
| `src/db/schema/` | This app's own tables. Never an `hf_*` table |
| `src/env.ts` | `REQUIRED_ENV`, the env contract both compose files are held to |
| `src/auth.ts` | better-auth and `requireSession()` — this app's one session boundary |
| `drizzle/` | This app's migrations. `pnpm db:generate` after a schema edit |
| `prompts/` | Prompt files, addressed by content hash |
| `fixtures/` | One per flow, named for the flow. The contract suite needs it |
| `fixtures/llm/` | `<promptName>.json`, served whenever no provider key is set |
| `fixtures/sources/` | What the demo source streams, in place of a real API |
| `app/` | The two catch-all routes, `/auth/*`, and the two API mounts. Almost nothing per-app |
| `worker.ts` / `migrate.ts` | The worker — which also drives `app.schedules` — and the one-shot migrator |

## Working here

```
docker compose up -d      # postgres (pgvector/pg17) and mailpit
hf dev                    # sets HF_BUILD_SHA=dev-<timestamp>, runs web and worker
pnpm typecheck && pnpm lint && pnpm test
```

Before claiming anything works: `pnpm test` against a real Postgres. The suite spawns a real
worker process, because `startWorker()` cannot be tested any other way — DBOS refuses a second
launch in one process, and the advisory lock is released by process death and nothing else.

## What not to do

- **Do not edit anything in `node_modules/@hyperfixation/`.** A core change belongs in
  `hyperfixation-core`; it reaches this app through the `core-bump` PR, which this app's own
  contract suite gates.
- **Do not deep-import** `@hyperfixation/*/src/*` or `/dist/*`. The `exports` map makes it a
  resolver error and ESLint names the reason.
- **Do not archive a record from inside a run.** `records.archive()` is a control-plane
  operation and throws `ControlPlaneInWorkflow`. A flow that wants one creates a task.
- **Do not add a var to one compose service.** `REQUIRED_ENV`, both `environment:` blocks and
  `.env.example` move together, and `compose-envs.test.ts` fails if they do not.

## Replacing the demo

The template ships the first half of a working loop, on one record table (`demo_note`), so the
contract suite has something real to hold and so the shape of every registration is visible
rather than described: a source, a resolver, a spec, a scorer, and the three flows that chain
them — `collectDemoSource`, `resolveDemoSource`, `scoreDemoNotes`, each on a schedule. With no
provider key set the scorer's calls come from `fixtures/llm/`, so it all runs on a laptop and in
CI for nothing. `.claude/skills/replace-demo/` is the guided way to swap it for this app's own
domain.
