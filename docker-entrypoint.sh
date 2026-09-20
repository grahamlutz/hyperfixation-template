#!/bin/sh
set -e

# `ENV HF_BUILD_SHA=$SOURCE_COMMIT` in the Dockerfile covers a build that was given the commit
# as an arg. This covers the one that was not — which on Coolify is every build. Docker cannot
# compute an `ENV` from a `RUN`, so the builder writes the resolved sha to a file and the
# fallback happens here, once, before the process that reads it starts.
#
# It never overrides a value already in the environment, and on a deploy there always is one:
# compose passes `HF_BUILD_SHA` through from `SOURCE_COMMIT`, which `hf deploy` writes to the
# app's Coolify environment beforehand. A deploy that set it deliberately outranks anything
# baked into the image.
if [ -z "${HF_BUILD_SHA:-}" ] && [ -r /app/.hf-build-sha ]; then
  HF_BUILD_SHA="$(cat /app/.hf-build-sha)"
  export HF_BUILD_SHA
fi

exec "$@"
