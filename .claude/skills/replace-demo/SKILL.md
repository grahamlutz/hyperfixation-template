---
name: replace-demo
description: Replace the template's demo loop and demo record table with this app's own domain. Use once, right after `hf new`, when the app's first real flow or record type is being written and the `demoBusinesses` registrations and `demo_note` are still in the tree.
---

# Replace the demo

`hf new` leaves a working loop in place — the `demoBusinesses` source, the `demoNotes` resolver,
the `demoFit` spec and scorer, the `demoDraft` approval type, the `email` channel, the four flows
that chain them (`collectDemoSource`, `resolveDemoSource`, `scoreDemoNotes`, `draftDemoOutreach`)
and one record table (`demo_note`). It exists so `tests/contract.test.ts` and
`tests/flow-restart.test.ts` have something real to run on day one — a contract suite with nothing
registered passes vacuously, which is worse than no suite — and so each kind of registration has
one worked example to read. This skill swaps it for the app's own domain without leaving the suite
empty in between.

Every file the demo owns, so the swap is a checklist rather than an `rg`:

| Kind | Files |
|---|---|
| Registry | `src/hyperfixation.ts` — the `flows`, `records`, `sources`, `resolvers`, `specs`, `scorers`, `approvalTypes`, `channels` and `schedules` arrays |
| Source | `src/sources/demo.ts`, `fixtures/sources/demoBusinesses.json` |
| Resolver | `src/resolvers/demo.ts` |
| Spec and scorer | `src/specs/demo.ts`, `src/scorers/demo.ts` |
| Approval type | `src/approvals/demo-draft.ts` |
| Channel | `src/channels/email.ts` |
| Flows | `src/flows/collect-demo-source.ts`, `resolve-demo-source.ts`, `score-demo-notes.ts`, `draft-demo-outreach.ts` |
| Flow fixtures | `fixtures/collectDemoSource.json`, `resolveDemoSource.json`, `scoreDemoNotes.json`, `draftDemoOutreach.json` |
| Prompts, each with its fixture | `prompts/score.md` with `fixtures/llm/score.json`, `prompts/draft.md` with `fixtures/llm/draft.json` |
| Record table | `src/db/schema/demo.ts` and its `export` in `src/db/schema/index.ts`; `drizzle/0000_demo_note.sql`, `0001_demo_note_mixin.sql`, `0002_demo_note_contact_email.sql` |
| Tests | `tests/contract.test.ts`, `flow-restart.test.ts`, `draft-approval.test.ts`, `demo-draft-schema.test.ts`, `records-archive.test.ts` |

`src/llm.ts`, `tests/worker-fixture.ts` and `tests/compose-envs.test.ts` are the app's, not the
demo's, and stay as they are.

## Do it in this order

The order matters: the tree must typecheck and the suite must have at least one registered flow
at every step, so a mistake is caught by the next command rather than three steps later.

### 1. Learn the domain before writing anything

Ask, and do not guess:

- What does this app *collect*? That is a source and a record type.
- What does it *decide*? That is a scorer, or a flow that calls `llm.run`.
- What does a human *approve*? That is an approval type and the flow that waits on it.
- What *leaves the system*? That is an action channel, and it needs an idempotency key.

Write the answers down before touching a file. A record table's name and a flow's name are
stored in `hf_run.flow`, `hf_approval.type` and `hf_action_log.channel` forever; renaming one
later means migrating rows, not renaming a symbol.

### 2. Add the real record table, keeping the demo one

```
pnpm gen              # choose "record"
pnpm db:generate      # writes drizzle/<next number>_<name>.sql
pnpm typecheck
```

The generated table spreads `hfRecordColumns()` — `normalized_name`, `archived_at`, `stage`,
the score pair, `spec_version` — because the machinery addresses those columns by name on
whatever table a record type points at. Add this app's own columns after the spread; a column
redeclared there wins, which is how a mixin column gets tightened to `NOT NULL` or made
unique, as `demo_note` does with `normalized_name`.

Check the generated SQL before committing it. It must not create, alter or drop an `hf_*`
table (boot check E005) and must not carry a foreign key to one (E004). `CREATE EXTENSION`
must be `IF NOT EXISTS`, and an `ADD COLUMN` against an existing table must be nullable or
carry a default — the migrator's allowlist refuses the rest.

### 3. Add the real flow, keeping the demo one

```
pnpm gen              # choose "flow", pick its queue
```

Fill in the body, then fill in `fixtures/<flowName>.json` to match its input type. Every step
needs a `key`; every write goes through `ctx.tx`.

Then:

```
pnpm test             # the new flow now runs through a restart too
```

If this is red, the flow is not idempotent across an attempt bump. That is a real defect, not
a test artifact: read `CLAUDE.md`'s first section before changing the test.

### 4. Only now, remove the demo

Delete, in one commit:

- `src/flows/collect-demo-source.ts`, `src/flows/resolve-demo-source.ts`,
  `src/flows/score-demo-notes.ts`, `src/flows/draft-demo-outreach.ts` and their entries in
  `src/hyperfixation.ts`'s `flows`
- `fixtures/collectDemoSource.json`, `fixtures/resolveDemoSource.json`,
  `fixtures/scoreDemoNotes.json`, `fixtures/draftDemoOutreach.json`
- `src/sources/demo.ts`, `src/resolvers/demo.ts`, `src/specs/demo.ts`, `src/scorers/demo.ts` and
  their entries in `src/hyperfixation.ts`'s `sources`, `resolvers`, `specs`, `scorers` and
  `schedules` — the three demo schedules go with the flows they fire
- `src/approvals/demo-draft.ts` and its `approvalTypes` entry, and
  `tests/demo-draft-schema.test.ts` with it — but copy the validators into the real approval type
  first. A length cap, no URL, no phone number and a recipient allowlist are what this app is
  allowed to send, not what the demo was
- `src/channels/email.ts` and its `channels` entry **only if this app sends no email**. If it
  does, keep the file and change the request shape: what matters is `dedupes: false`, which is
  true of every SMTP server and of most providers' plain send endpoints
- `prompts/score.md` and `prompts/draft.md` with `fixtures/llm/score.json` and
  `fixtures/llm/draft.json`, each pair together: a prompt file with no fixture is a
  `FixtureMissing` on every keyless run, and a fixture with no prompt is never read
- `fixtures/sources/demoBusinesses.json`
- the `demo_note` entry in `src/hyperfixation.ts`'s `records`
- `demo_note` from `APP_TABLES` in `tests/flow-restart.test.ts`, replacing it with the tables
  the real flows write — and the two values tests in the same file, "left the demo loop's own rows
  behind" and "left one pending draft approval behind", replaced by the equivalent assertions on
  what the app's own loop produces. The `it.each` over `app.flows.all()` needs no edit: it picks
  up whatever is registered, which is why step 3 comes before this one
- `tests/contract.test.ts`, repointed at the app's own loop rather than deleted: it is the only
  suite that runs the chain once, end to end, and asserts the rows it left. Keep its shape — the
  keyless-and-mailserverless guard, the `runFlowSync` pass over every flow in registration order,
  the decision, and the assertion that nothing was billed — and change what it counts
- `tests/draft-approval.test.ts`, repointed at the app's own approval and channel rather than
  deleted: the restart harness never decides an approval, so nothing else covers the half of a
  flow that runs after the gate — `ActionUncertain` in particular
- `tests/records-archive.test.ts`, repointed at a real record type rather than deleted: it is
  what catches a record table that never adopted `hfRecordColumns()`, which fails as a `42703`
  from `records.archive()` and in no other suite

Keep `src/llm.ts`: it is the app's provider registry, not part of the demo. Only the model name
and prompt name inside a scorer are.

**Leave `demo_note` in the database, and leave `src/db/schema/demo.ts` and its `export` in
`src/db/schema/index.ts` where they are.** The migrator refuses every `DROP` in an app migration
on purpose (`assertAppMigrationAllowed`): deleting data automatically at deploy is what its
allowlist exists to prevent. Deleting the schema file would make `pnpm db:generate` emit a
`DROP TABLE demo_note` migration that can never run. An unused table costs nothing. If you want
it gone, drop it by hand on each database in a reviewed step outside the migrator, and keep the
schema file so drizzle's snapshot still agrees. Never edit `drizzle/0000_demo_note.sql`,
`0001_demo_note_mixin.sql` or `0002_demo_note_contact_email.sql`: a migration that has run
somewhere is history, and rewriting it makes the journal disagree with the database.

```
pnpm db:generate
pnpm typecheck && pnpm lint && pnpm test
```

### 5. Check what still says "demo"

```
rg -i 'demo' --glob '!node_modules' --glob '!drizzle/*.sql'
```

`prompts/README.md`, this skill, `src/db/schema/demo.ts` and its `export` are allowed to.
Nothing else should be.

## What not to do

- Do not delete the demo first and add the real thing after. `flow-restart.test.ts` asserts at
  least one flow is registered, and a window where it passes on nothing is a window where a
  broken fixture path goes unnoticed.
- Do not drop the `demoNote` entry from `records` on a database the demo loop has already run
  on. `hf_approval`, `hf_action_log`, `hf_activity`, `hf_task`, `hf_score` and `hf_label` all
  carry `record_type = 'demoNote'` by then, and boot check E002 refuses the next boot over a
  type nobody registers. Delete those rows in the same reviewed step that drops the
  registration — `tests/contract.test.ts` asserts exactly this failure, against a real loop's
  rows, so it is the fastest way to see what E002 would say.
