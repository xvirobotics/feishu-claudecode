#!/usr/bin/env node
/**
 * Sync the transcript SPA into cloud/static/transcript-spa/.
 *
 * Expects the main repo's `npm run build:web` to have produced `dist/web/`
 * relative to the repo root. Wipes the cloud static dir first and then copies
 * the entire SPA build verbatim. Driven by `npm -w @metabot/cloud run build:spa`
 * and by the Docker build stage.
 *
 * Exits non-zero with a helpful message if `dist/web/index.html` is missing,
 * since shipping a stale placeholder would silently break the cloud relay.
 */
import { existsSync, rmSync, cpSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// cloud/scripts/sync-spa.mjs → repo root is two levels up.
const repoRoot   = path.resolve(__dirname, '..', '..');
const srcDir     = path.join(repoRoot, 'dist', 'web');
const dstDir     = path.resolve(__dirname, '..', 'static', 'transcript-spa');
const srcIndex   = path.join(srcDir, 'index.html');

function fail(msg) {
  console.error(`[sync-spa] ${msg}`);
  process.exit(1);
}

if (!existsSync(srcIndex)) {
  fail(
    `expected SPA build at ${srcIndex} — run "npm run build:web" at repo root first`,
  );
}

const indexStat = statSync(srcIndex);
if (indexStat.size < 100) {
  fail(`${srcIndex} is suspiciously small (${indexStat.size} bytes)`);
}

rmSync(dstDir, { recursive: true, force: true });
mkdirSync(dstDir, { recursive: true });
cpSync(srcDir, dstDir, { recursive: true });

console.log(`[sync-spa] copied ${srcDir} → ${dstDir}`);
