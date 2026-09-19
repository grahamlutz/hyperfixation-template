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
`tests/contract.test.ts` is its other half: the same flows run **once**, in order, with the
approval decided and the rows asserted — because four flows that each did nothing pass a
restart just as well as four that ran the loop.

## Layout

| Path | What lives there |
|---|---|
| `src/hyperfixation.ts` | `defineApp` — the registry of everything this app has |
| `src/flows/` | Flows. `pnpm gen` scaffolds one and registers it |
| `src/sources/` | `defineSource` — what a collect flow streams into `hf_source_record` |
| `src/resolvers/` | `defineResolver` — which record a loaded row is, and how to create or update it |
| `src/specs/` / `src/scorers/` | `defineSpec` and `defineScorer` — the criteria, and the call that judges against them |
| `src/approvals/` | One file per approval type: the Zod schema an edited draft is parsed against |
| `src/channels/` | `ActionChannel`s — everything that leaves the app from inside a run |
| `src/llm.ts` | The app's one `createLlm`: the provider registry and `prompts/` |
| `src/db/schema/` | This app's own tables. Never an `hf_*` table |
| `src/env.ts` | `REQUIRED_ENV`, the env contract both compose files are held to |
| `src/auth.ts` | better-auth and `requireSession()` — this app's one session boundary |
| `src/workspace.ts` | The workspace's one entry: the gate, the attached app, the session as `{ userId, admin }` |
| `drizzle/` | This app's migrations. `pnpm db:generate` after a schema edit |
| `prompts/` | Prompt files, addressed by content hash |
| `fixtures/` | One per flow, named for the flow. The contract suite needs it |
| `fixtures/llm/` | `<promptName>.json`, served whenever no provider key is set |
| `fixtures/sources/` | What the demo source streams, in place of a real API |
| `tests/` | `contract` (the loop once, end to end), `flow-restart` (every flow twice), `draft-approval` (past the gate), `demo-draft-schema` (the validators alone), `records-archive` (the mixin), `workspace-render` (model output rendered as text), `inbox-render` (the same claim about the boxes that edit it), `inbox-decide` (one submission, one batch, one replay key), `workspace-actor` (the session as an actor), `compose-envs` (the env contract) |
| `app/` | The two catch-all routes, `/auth/*`, and the two API mounts. Almost nothing per-app |
| `app/(workspace)/w/[[...path]]/` | The workspace: `page.tsx` renders what `app.workspace.route()` resolved, `views.tsx` is the screens, `actions.ts` the label and the archive |
| `…/inbox.tsx`, `inbox-actions.ts` | The approval inbox and the one batch decision it posts. `decide-form.ts` is that form turned into a single `decide()` call — ids, edits, the replay key — and `decision-key.tsx` is the key itself, minted in the browser once per mount |
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
- **Do not declare `dedupes: true` on a channel whose provider does not dedupe on the
  `idempotencyKey`.** It is the only thing telling `actions.perform` whether a send left in flight
  by an attempt that is gone may be repeated. Declared falsely, a redeploy mid-send delivers
  twice; declared honestly, the row goes `uncertain`, a task asks a human, and the run fails with
  `ActionUncertain` — which is the correct outcome and not something to catch.
- **Do not put an approval's validators in the flow.** They belong on the approval type's Zod
  schema, because `approvals.decide` is what parses an **edited** draft, and a rule the flow
  enforces is a rule the inbox's text box does not.

## Replacing the demo

The template ships a working loop, on one record table (`demo_note`), so the contract suite has
something real to hold and so the shape of every registration is visible rather than described:

| | |
|---|---|
| `src/sources/demo.ts` | the `demoBusinesses` source, over `fixtures/sources/demoBusinesses.json` |
| `src/resolvers/demo.ts` | the `demoNotes` resolver — exact on `normalized_name`, then trigram |
| `src/specs/demo.ts`, `src/scorers/demo.ts` | the `demoFit` criteria and the `llm.run` that judges against them |
| `src/approvals/demo-draft.ts` | the `demoDraft` schema: the length caps, no URL, no phone, the contact allowlist |
| `src/channels/email.ts` | the `email` channel, `dedupes: false` |
| `src/flows/` | `collectDemoSource`, `resolveDemoSource`, `scoreDemoNotes` — one schedule each — and `draftDemoOutreach`, started for a record rather than on a clock because it asks a human |
| `prompts/score.md`, `prompts/draft.md` | with `fixtures/llm/score.json` and `draft.json` beside them |

With no provider key set the model's answers come from `fixtures/llm/` and with `SMTP_URL` unset
the channel serializes the mail instead of sending it, so it all runs on a laptop and in CI for
nothing. `.claude/skills/replace-demo/` is the guided way to swap it for this app's own domain,
and it names every file to touch.
