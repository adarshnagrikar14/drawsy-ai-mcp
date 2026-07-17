#!/bin/sh
set -eu

persistent_home="${DRAWSY_CODEX_PERSISTENT_HOME:-/root/.codex-persistent}"
runtime_home="${CODEX_HOME:-/app/codex-runtime}"

rm -rf "$runtime_home"
mkdir -p "$runtime_home"

for entry in \
  auth.json \
  config.toml \
  installation_id \
  models_cache.json \
  .personality_migration \
  skills
do
  if [ -e "$persistent_home/$entry" ]; then
    cp -a "$persistent_home/$entry" "$runtime_home/$entry"
  fi
done

# Codex creates an executable sandbox-helper symlink below CODEX_HOME/tmp.
# Keep every parent directory traversable from its unprivileged user namespace.
mkdir -p "$runtime_home/tmp"
find "$runtime_home" -type d -exec chmod 755 {} +

exec "$@"
