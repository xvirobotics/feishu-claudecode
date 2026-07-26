#!/usr/bin/env bash
# Pack the metabot runtime into a tarball + publish the bootstrap
# installer script. Output lands under `packages/server/static/install/`,
# which is published to the server's static dir at install time.
# The tarball + script are served anonymously at
# `<host>/install/{install.sh,latest.tgz}` (see server.ts /install route).
#
# What ships in the tarball:
#   - bin/, install.sh, ecosystem.config.cjs, tsconfig*.json
#   - package.json + package-lock.json (runtime-only workspace manifest)
#   - src/                              (engine + workspace skill sources)
#   - packages/cli, cli-core, metamemory, skill-hub  (4 bot-host workspaces)
#   - packages/skills/metabot           (Phase 6 SKILL_SENTINEL)
#   - packages/skills/metabot-team      (Agent Teams CLI skill)
#
# What does NOT ship in the default bridge flavor (central-only):
#   - packages/server, packages/web-ui
#
# The public GitHub Release sets METABOT_PACKAGE_FLAVOR=personal. That flavor
# adds the local Core server + Web UI sources so the same one-line installer
# produces a complete self-hosted personal edition instead of a bridge that
# points at a Core service the user does not have.
#   - node_modules, dist, *.tsbuildinfo, coverage
#   - .git, .github, .codex
#   - .env, bots.json, logs/, data/   (never committed — naturally absent)
#
# Optional packaged defaults:
#   - If METABOT_PACKAGE_DEFAULT_ENV_FILE (or METABOT_INTERNAL_DEFAULT_ENV_FILE)
#     points to a local env file at pack time, it is embedded as
#     .metabot-package/default.env. The bootstrap installer copies it to
#     ~/.metabot/default.env with chmod 600, then removes the extracted copy.
#     Do not store that source file in git.
#
# Implementation note: we drive tar directly (no rsync staging) so CI runners
# without rsync still work. `tar --exclude` patterns recurse into every named
# include path, giving the same effect as rsync staging.
#
# Output is atomic (`*.new` → rename) so a mid-deploy rsync can't catch a
# half-written tarball.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SERVER_PKG_DIR/../.." && pwd)"
SERVER_STATIC_DIR="${METABOT_PACK_OUTPUT_DIR:-$SERVER_PKG_DIR/static/install}"
BOOTSTRAP_SRC="$SERVER_PKG_DIR/install/bootstrap.sh"
PACKAGE_DEFAULT_ENV_FILE="${METABOT_PACKAGE_DEFAULT_ENV_FILE:-${METABOT_INTERNAL_DEFAULT_ENV_FILE:-}}"
PACKAGE_FLAVOR="${METABOT_PACKAGE_FLAVOR:-bridge}"

case "$PACKAGE_FLAVOR" in
  bridge|personal) ;;
  *)
    echo "error: unsupported METABOT_PACKAGE_FLAVOR: $PACKAGE_FLAVOR" >&2
    exit 1
    ;;
esac

TARBALL_NAME="latest.tgz"
BOOTSTRAP_NAME="install.sh"

VERSION="$(node -e "process.stdout.write(require('$REPO_ROOT/package.json').version)")"
RELEASE_VERSION="${METABOT_RELEASE_VERSION:-$VERSION}"

# Patterns excluded from every recursive include. Mirrors what rsync staging
# used to skip; tar applies these globally regardless of which include path
# is being walked.
TAR_EXCLUDES=(
  '--exclude=.git'
  '--exclude=.github'
  '--exclude=.codex'
  '--exclude=node_modules'
  '--exclude=dist'
  '--exclude=*.tsbuildinfo'
  '--exclude=coverage'
  '--exclude=packages/server/static'
  '--exclude=src/workspace'
  '--exclude=src/skills/metabot-team'
  '--exclude=src/skills/voice'
  '--exclude=.DS_Store'
  '--exclude=*.log'
)

# Explicit include list — only these paths get into the tarball.
# packages/server + packages/web-ui are intentionally OMITTED (central-only).
# packages/skills/metabot/ is required for Phase 6 SKILL_SENTINEL check.
# packages/skills/metabot-team/ keeps the Codex Agent Teams workflow installable
# from the packaged Skill Hub path.
INCLUDES=(
  'bin'
  'install.sh'
  'ecosystem.config.cjs'
  'package-lock.json'
  'tsconfig.bridge.json'
  'src'
  'packages/cli'
  'packages/cli-core'
  'packages/metamemory'
  'packages/skill-hub'
  'packages/skills'
  'LICENSE'
  'README.md'
)

if [[ "$PACKAGE_FLAVOR" == "personal" ]]; then
  INCLUDES+=(
    'ecosystem.core.config.cjs'
    'packages/server'
    'packages/web-ui'
  )
fi

# Filter to paths that actually exist. tar would error on a missing positional
# argument, and a missing optional file (e.g. LICENSE not yet checked in)
# shouldn't break the build.
PRESENT_INCLUDES=()
for rel in "${INCLUDES[@]}"; do
  if [[ -e "$REPO_ROOT/$rel" ]]; then
    PRESENT_INCLUDES+=("$rel")
  else
    echo "    (skipping missing: $rel)" >&2
  fi
done

# install.sh and the metabot SKILL bundle are load-bearing — if either is
# missing, the bootstrap → install.sh → Phase 6 chain will explode on the
# bot host. Fail loud here instead.
for required in 'install.sh' 'packages/skills/metabot/SKILL.md' 'packages/skills/metabot-team/SKILL.md'; do
  if [[ ! -e "$REPO_ROOT/$required" ]]; then
    echo "error: required path missing from repo: $required" >&2
    exit 1
  fi
done

mkdir -p "$SERVER_STATIC_DIR"

TMP_EXTRA_DIR="$(mktemp -d -t metabot-pack-extra.XXXXXX)"
STAGE_DIR=""
cleanup() {
  rm -rf "$TMP_EXTRA_DIR"
  if [[ -n "$STAGE_DIR" ]]; then
    rm -rf "$STAGE_DIR"
  fi
}
trap cleanup EXIT

if [[ -n "$PACKAGE_DEFAULT_ENV_FILE" ]]; then
  if [[ ! -f "$PACKAGE_DEFAULT_ENV_FILE" ]]; then
    echo "error: METABOT_PACKAGE_DEFAULT_ENV_FILE does not exist: $PACKAGE_DEFAULT_ENV_FILE" >&2
    exit 1
  fi
  mkdir -p "$TMP_EXTRA_DIR/.metabot-package"
  cp "$PACKAGE_DEFAULT_ENV_FILE" "$TMP_EXTRA_DIR/.metabot-package/default.env"
  chmod 600 "$TMP_EXTRA_DIR/.metabot-package/default.env"
  EXTRA_TAR_ARGS=(-C "$TMP_EXTRA_DIR" '.metabot-package/default.env')
  echo "==> Embedding packaged default env from $PACKAGE_DEFAULT_ENV_FILE"
fi

echo "==> Writing $PACKAGE_FLAVOR package manifests"
node - "$REPO_ROOT/package.json" "$TMP_EXTRA_DIR/package.json" "$RELEASE_VERSION" "$PACKAGE_FLAVOR" <<'NODE'
const fs = require('node:fs');
const [src, dest, releaseVersion, flavor] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(src, 'utf8'));
pkg.version = releaseVersion;
if (flavor === 'bridge') {
  delete pkg.metabotEdition;
  pkg.workspaces = [
    'packages/cli',
    'packages/cli-core',
    'packages/metamemory',
    'packages/skill-hub',
  ];
  pkg.scripts = {
    ...pkg.scripts,
    build: 'npm run build:bridge',
    'build:packages': 'npm run build --workspaces --if-present',
    test: 'vitest run',
  };
  delete pkg.scripts['build:web'];
}
fs.writeFileSync(dest, `${JSON.stringify(pkg, null, 2)}\n`);
NODE

node - "$REPO_ROOT/tsconfig.json" "$TMP_EXTRA_DIR/tsconfig.json" "$PACKAGE_FLAVOR" <<'NODE'
const fs = require('node:fs');
const [src, dest, flavor] = process.argv.slice(2);
const tsconfig = JSON.parse(fs.readFileSync(src, 'utf8'));
if (flavor === 'bridge') {
  tsconfig.references = (tsconfig.references || []).filter((ref) =>
    !['./packages/server', './packages/web-ui'].includes(ref.path),
  );
}
fs.writeFileSync(dest, `${JSON.stringify(tsconfig, null, 2)}\n`);
NODE

mkdir -p "$TMP_EXTRA_DIR/.metabot-package"
node - "$REPO_ROOT/package.json" "$TMP_EXTRA_DIR/.metabot-package/manifest.json" "$RELEASE_VERSION" "$PACKAGE_FLAVOR" <<'NODE'
const fs = require('node:fs');
const [pkgPath, dest, releaseVersion, flavor] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const manifest = {
  schemaVersion: 1,
  package: flavor === 'personal' ? 'metabot-personal-edition' : 'metabot-runtime',
  version: releaseVersion,
  sourcePackageVersion: pkg.version,
  channel: 'install',
  includesCore: flavor === 'personal',
  includesWebUi: flavor === 'personal',
};
fs.writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

EXTRA_MEMBERS=('package.json' 'tsconfig.json' '.metabot-package/manifest.json')
if [[ -f "$TMP_EXTRA_DIR/.metabot-package/default.env" ]]; then
  EXTRA_MEMBERS+=('.metabot-package/default.env')
fi
EXTRA_TAR_ARGS=(-C "$TMP_EXTRA_DIR" "${EXTRA_MEMBERS[@]}")

echo "==> Writing $SERVER_STATIC_DIR/$TARBALL_NAME (atomic)"
# Sort+mtime flags produce a deterministic tarball — easier diffs across
# builds and avoids spurious rsync churn on the deploy host. -C anchors all
# include paths to the repo root.
#
# --sort/--owner/--group/--mtime are GNU tar extensions. Linux ships GNU tar
# as `tar`, but macOS ships BSD tar (bsdtar), which rejects them
# ("Option --sort=name is not supported"). Prefer GNU tar when present
# (Homebrew installs it as `gtar`), otherwise emulate the same determinism
# guarantees with a BSD-compatible pipeline.
GNU_TAR=""
for tar_candidate in tar gtar; do
  if "$tar_candidate" --version 2>/dev/null | grep -q 'GNU tar'; then
    GNU_TAR="$tar_candidate"
    break
  fi
done

if [[ -n "$GNU_TAR" ]]; then
  "$GNU_TAR" --sort=name \
      --owner=0 --group=0 --numeric-owner \
      --mtime='UTC 2026-01-01' \
      "${TAR_EXCLUDES[@]}" \
      -czf "$SERVER_STATIC_DIR/$TARBALL_NAME.new" \
      -C "$REPO_ROOT" \
      "${PRESENT_INCLUDES[@]}" \
      "${EXTRA_TAR_ARGS[@]}"
else
  # BSD tar fallback (stock macOS). Reproduce the GNU flags in three steps:
  #   1. Stage the payload with bsdtar itself, so the TAR_EXCLUDES patterns
  #      keep their create-time recursion semantics (bsdtar matches path
  #      components the same way GNU tar does).
  #   2. Pin every staged mtime to the instant GNU's --mtime pins
  #      (2026-01-01 00:00:00 UTC).
  #   3. Archive an explicitly pre-sorted member list with tar recursion
  #      disabled (-n) — the --sort=name replacement — forcing uid/gid 0
  #      like --owner/--group, and gzip -n for a timestamp-free header.
  STAGE_DIR="$(mktemp -d -t metabot-pack-stage.XXXXXX)"
  tar "${TAR_EXCLUDES[@]}" -cf - -C "$REPO_ROOT" "${PRESENT_INCLUDES[@]}" \
    | tar -xpf - -C "$STAGE_DIR"
  tar -cf - -C "$TMP_EXTRA_DIR" "${EXTRA_MEMBERS[@]}" \
    | tar -xpf - -C "$STAGE_DIR"
  TZ=UTC0 find "$STAGE_DIR" -exec touch -h -t 202601010000.00 {} +
  (
    cd "$STAGE_DIR" \
      && find . -mindepth 1 \
        | sed 's,^\./,,' \
        | LC_ALL=C sort \
        | tar --format gnutar --uid 0 --gid 0 --numeric-owner -n -cf - -T - \
        | gzip -n
  ) > "$SERVER_STATIC_DIR/$TARBALL_NAME.new"
fi

# Post-pack sanity: confirm SKILL_SENTINEL actually landed in the tarball.
# Catches cases where an --exclude pattern accidentally swallowed it.
# Post-pack sanity: confirm SKILL_SENTINEL actually landed in the tarball.
# Catches cases where an --exclude pattern accidentally swallowed it.
#
# We snapshot the listing to a variable instead of piping `tar tzf | grep -q`:
# under `set -o pipefail`, an early-exiting `grep -q` sends SIGPIPE upstream
# and the pipeline fails even though the match succeeded. Classic footgun.
TARBALL_LISTING="$(tar tzf "$SERVER_STATIC_DIR/$TARBALL_NAME.new")"
if ! grep -Eq '^(\./)?packages/skills/metabot/SKILL\.md$' <<<"$TARBALL_LISTING"; then
  echo "error: packed tarball is missing packages/skills/metabot/SKILL.md" >&2
  rm -f "$SERVER_STATIC_DIR/$TARBALL_NAME.new"
  exit 1
fi
if ! grep -Eq '^(\./)?packages/skills/metabot-team/SKILL\.md$' <<<"$TARBALL_LISTING"; then
  echo "error: packed tarball is missing packages/skills/metabot-team/SKILL.md" >&2
  rm -f "$SERVER_STATIC_DIR/$TARBALL_NAME.new"
  exit 1
fi
if [[ "$PACKAGE_FLAVOR" == "personal" ]] && grep -Eq '^(\./)?packages/server/static(/|$)' <<<"$TARBALL_LISTING"; then
  echo "error: personal package contains prebuilt/stale packages/server/static content" >&2
  rm -f "$SERVER_STATIC_DIR/$TARBALL_NAME.new"
  exit 1
fi

mv "$SERVER_STATIC_DIR/$TARBALL_NAME.new" "$SERVER_STATIC_DIR/$TARBALL_NAME"

echo "==> Publishing bootstrap $SERVER_STATIC_DIR/$BOOTSTRAP_NAME (atomic)"
if [[ ! -f "$BOOTSTRAP_SRC" ]]; then
  echo "error: bootstrap source missing at $BOOTSTRAP_SRC" >&2
  exit 1
fi
cp "$BOOTSTRAP_SRC" "$SERVER_STATIC_DIR/$BOOTSTRAP_NAME.new"
chmod +x "$SERVER_STATIC_DIR/$BOOTSTRAP_NAME.new"
mv "$SERVER_STATIC_DIR/$BOOTSTRAP_NAME.new" "$SERVER_STATIC_DIR/$BOOTSTRAP_NAME"

SIZE="$(ls -lh "$SERVER_STATIC_DIR/$TARBALL_NAME" | awk '{print $5}')"
echo "==> Done. metabot $PACKAGE_FLAVOR package v$RELEASE_VERSION → $SERVER_STATIC_DIR/$TARBALL_NAME ($SIZE)"
