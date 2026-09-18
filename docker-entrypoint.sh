#!/bin/sh
set -e

# `ENV HF_BUILD_SHA=$SOURCE_COMMIT` in the Dockerfile covers the case the plan assumes: Coolify
# passes the commit as a build arg. This covers the case it does not. Docker cannot compute an
# `ENV` from a `RUN`, so the builder writes the resolved sha to a file and the fallback happens
# here, once, before the process that reads it starts.
#
# It never overrides a value already in the environment: compose passes `HF_BUILD_SHA` through
# explicitly, and a deploy that set it deliberately outranks anything baked into the image.
if [ -z "${HF_BUILD_SHA:-}" ] && [ -r /app/.hf-build-sha ]; then
  HF_BUILD_SHA="$(cat /app/.hf-build-sha)"
  export HF_BUILD_SHA
fi

exec "$@"
