---
name: replace-demo
description: Replace the template's demo flow and demo record table with this app's own domain. Use once, right after `hf new`, when the app's first real flow or record type is being written and `recordDemoNote`/`demo_note` are still in the tree.
---

# Replace the demo

`hf new` leaves one flow (`recordDemoNote`) and one record table (`demo_note`) in place. They
exist so `tests/flow-restart.test.ts` has something real to run on day one — a contract suite
with nothing registered passes vacuously, which is worse than no suite. This skill swaps them
for the app's own domain without leaving the suite empty in between.

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

- `src/flows/demo.ts` and its entry in `src/hyperfixation.ts`'s `flows`
- `fixtures/recordDemoNote.json`
- `src/db/schema/demo.ts`, its `export` in `src/db/schema/index.ts`, and the `demo_note` entry
  in `src/hyperfixation.ts`'s `records`
- `demo_note` from `APP_TABLES` in `tests/flow-restart.test.ts`, replacing it with the tables
  the real flows write
- `tests/records-archive.test.ts`, repointed at a real record type rather than deleted: it is
  what catches a record table that never adopted `hfRecordColumns()`, which fails as a `42703`
  from `records.archive()` and in no other suite

Add a migration dropping `demo_note` — do not edit `drizzle/0000_demo_note.sql`. A migration
that has run somewhere is history; rewriting it makes the journal disagree with the database.

```
pnpm db:generate
pnpm typecheck && pnpm lint && pnpm test
```

### 5. Check what still says "demo"

```
rg -i 'demo' --glob '!node_modules' --glob '!drizzle/*.sql'
```

`prompts/README.md` and this skill are allowed to. Nothing else should be.

## What not to do

- Do not delete the demo first and add the real thing after. `flow-restart.test.ts` asserts at
  least one flow is registered, and a window where it passes on nothing is a window where a
  broken fixture path goes unnoticed.
- Do not keep `demo_note` "just in case". It has a delete-guard trigger and a `record_type`
  registration; an unregistered type left in a machinery row fails boot check E002.
