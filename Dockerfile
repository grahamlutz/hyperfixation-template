# One image, three services. `web`, `worker` and `migrate` differ only by the command compose
# gives them and by the `HF_PROCESS` they run under — which is what makes "the worker is on the
# same commit as the web" true by construction rather than by deployment discipline.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
# `pnpm-workspace.yaml` too: pnpm 12 reads `minimumReleaseAgeExclude` and `allowBuilds` from
# there, so without it the install stalls 24 hours on a just-published `@hyperfixation/*` and
# refuses to decide about `@sentry/cli`'s build script.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS builder
# `git` is here for the SOURCE_COMMIT fallback below, and `.git` is deliberately not in
# `.dockerignore` for the same reason.
RUN apk add --no-cache git
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# Prerendering `/auth/passkey` calls `requireEnv()` (src/env.ts), so the build needs values for
# what it reads. They are placeholders and they stay in this `RUN` — nothing is baked into the
# runner, which takes every one of these from compose at run time.
RUN HF_PROCESS=web \
    DATABASE_URL=postgres://unused \
    MIGRATOR_DATABASE_URL=postgres://unused \
    APP_URL=https://unused \
    BETTER_AUTH_SECRET=unused \
    SMTP_URL=smtp://unused \
    EMAIL_FROM=unused@example.com \
    pnpm build

# Coolify is expected to pass the deployed commit as this build arg. It is unverified that it
# does, so the build falls back to the checkout's own HEAD and, failing that, to nothing —
# `startWorker()` refuses an `HF_BUILD_SHA` shorter than 7 characters, so a build that resolved
# neither fails loudly at the first deploy rather than serving under a version it cannot name.
#
# Last in this stage, not before `pnpm build`: the arg changes every commit, and anything after
# it rebuilds with it.
ARG SOURCE_COMMIT=""
RUN SHA="${SOURCE_COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo '')}" \
    && printf '%s' "$SHA" > /app/.hf-build-sha \
    && echo "hf-build: HF_BUILD_SHA=${SHA:-<unresolved>}"

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The whole tree, not a pruned install. `next build` bundles the web; the worker and the
# migrator are `worker.ts` and `migrate.ts` run through tsx, and their imports reach
# `@hyperfixation/*`, `pg` and the DBOS SDK at run time. Tracing the web's bundle would leave
# every one of those out.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/worker.ts ./worker.ts
COPY --from=builder /app/migrate.ts ./migrate.ts
COPY --from=builder /app/src ./src
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/prompts ./prompts
# The fixture provider reads `fixtures/llm/` when no provider key is set, and the demo source
# reads `fixtures/sources/`; both resolve against the working directory at run time.
COPY --from=builder /app/fixtures ./fixtures
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The build arg again, because an ARG does not cross a stage. When Coolify supplies it the
# value is baked here, exactly as the plan describes; when it does not, the entrypoint reads
# the file the builder wrote. Both come after every `COPY` above for the same reason the
# builder resolves the sha last: they change every commit, and the copies are the slow part.
COPY --from=builder /app/.hf-build-sha ./.hf-build-sha
ARG SOURCE_COMMIT=""
ENV HF_BUILD_SHA=$SOURCE_COMMIT

USER node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
EXPOSE 3000
CMD ["node", "server.js"]
