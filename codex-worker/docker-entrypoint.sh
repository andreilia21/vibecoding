#!/bin/sh
set -eu

mkdir -p "${CODEX_HOME}" "${REPOS_DIR}"
chown -R codex:codex "${CODEX_HOME}"
chown codex:codex /work "${REPOS_DIR}"

export HOME=/home/codex
export USER=codex
export LOGNAME=codex

exec setpriv --reuid=codex --regid=codex --init-groups "$@"
