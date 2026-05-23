/**
 * Smoke test for the transcript SPA build artifact shipped with the cloud
 * image. PR-5a left a placeholder HTML at `cloud/static/transcript-spa/`;
 * PR-5c's Dockerfile + `npm run build:spa` script overwrite it with the real
 * vite build output. This test guards both the placeholder (so CI passes
 * when the dev hasn't run build:spa yet) AND the real build (asserting
 * `index.html` exists and is non-trivially sized) so we never accidentally
 * ship an empty static dir.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = path.dirname(__filename);
// __dirname = cloud/src/__tests__ → static lives at cloud/static.
const staticRoot   = path.resolve(__dirname, '..', '..', 'static', 'transcript-spa');
const indexPath    = path.join(staticRoot, 'index.html');

describe('cloud transcript SPA static dir', () => {
  it('cloud/static/transcript-spa/ exists', () => {
    expect(existsSync(staticRoot)).toBe(true);
  });

  it('index.html exists and is non-empty', () => {
    expect(existsSync(indexPath)).toBe(true);
    const size = statSync(indexPath).size;
    expect(size).toBeGreaterThan(50);
  });

  it('index.html contains a <body>', () => {
    const html = readFileSync(indexPath, 'utf-8');
    expect(html.toLowerCase()).toContain('<body');
  });
});
