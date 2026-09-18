# __APP_NAME__

A Hyperfixation app: a Next.js front end, a DBOS worker, and one Postgres database, deployed as
three containers from one image.

```
docker compose up -d                 # postgres (pgvector/pg17) and mailpit
cp .env.example .env
hf migrate                           # core migrations, this app's migrations, dbos schema
hf bootstrap --email you@example.com  # the first admin; there is no sign-up
hf dev                               # web and worker, HF_BUILD_SHA=dev-<timestamp>
```

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

`pnpm test:e2e` is separate and heavier: it drives a real browser through sign-in, passkey
enrolment and the admin's 404, against this app's own dev compose. It wants the four commands
above to have been run, plus `pnpm exec playwright install chromium` once. The passkey half
runs on a virtual authenticator inside the browser, so no hardware is involved.
`HF_E2E_BUILD=1 pnpm test:e2e` runs the same suite against the standalone build a deploy serves.
