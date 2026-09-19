# __APP_NAME__

A Hyperfixation app: a Next.js front end, a DBOS worker, and one Postgres database, deployed as
three containers from one image.

`hf new` already wrote `.env` and asked for the bootstrap admin's address. From here:

```
hf up   # install, infra, migrate, bootstrap, status tokens, then web and worker in the foreground
```

Safe to rerun: each step skips itself once it's already done, so `hf up` is also the everyday
"start the app" command.

- `http://localhost:3000/auth/sign-in` — an emailed code, then a passkey at `/auth/passkey`
- `http://localhost:3000/w` — the workspace
- `http://localhost:3000/admin` — the admin, for admins; a 404 for everyone else
- `http://localhost:3000/api/status` — health, queues, runs, approvals, spend, version
- `http://localhost:8025` — mailpit, where sign-in codes land

`CLAUDE.md` is the working guide: what this repo owns, what `@hyperfixation/*` owns, and the
run model everything else follows from. Read it before the first change.

## Verifying

```
pnpm typecheck && pnpm lint && pnpm test
docker compose -f docker-compose.prod.yml config
```

`pnpm test` needs a Postgres. It creates a database per test on the cluster
`HF_TEST_DATABASE_URL` names and drops it afterwards.

`pnpm test:e2e` is separate and heavier: it drives a real browser against this app's own dev
compose — `exit-bar.e2e.ts` through sign-in, passkey enrolment, the admin's 404 and the
workspace, and `demo-loop.e2e.ts` through the demo loop, two approvals with one edit, the mail
mailpit receives, and a pause and resume over `/api/status`. It wants `hf up` to have been
run once, plus `pnpm exec playwright install chromium`. The passkey half
runs on a virtual authenticator inside the browser, so no hardware is involved.
`HF_E2E_BUILD=1 pnpm test:e2e` runs the same suites against the standalone build a deploy serves.
