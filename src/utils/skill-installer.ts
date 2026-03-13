import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Logger } from './logger.js';

const USER_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/**
 * Resolve the bundled skills directory at runtime.
 * Works for both `tsx src/` (dev) and `node dist/` (prod):
 *   dev:  .../src/utils/skill-installer.ts  → .../src/skills/
 *   prod: .../dist/utils/skill-installer.js → .../dist/skills/
 */
function getBundledSkillsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(thisFile), '..', 'skills');
}

/**
 * Ensure a bundled MetaBot skill is installed at the user-level Claude skills
 * directory (~/.claude/skills/<skillName>/), making it available to all bots
 * regardless of their working directory.
 *
 * Skips if already installed. Safe to call concurrently.
 */
export async function ensureSkillInstalled(skillName: string, logger?: Logger): Promise<void> {
  const targetDir = path.join(USER_SKILLS_DIR, skillName);

  if (fs.existsSync(targetDir)) return;

  const sourceDir = path.join(getBundledSkillsDir(), skillName);
  if (!fs.existsSync(sourceDir)) {
    logger?.warn({ skillName, sourceDir }, 'Bundled skill not found, skipping installation');
    return;
  }

  try {
    copyDirSync(sourceDir, targetDir);
    logger?.info({ skillName, targetDir }, 'Skill installed to user skills directory');
  } catch (err) {
    logger?.warn({ err, skillName, targetDir }, 'Failed to install skill');
  }
}

/**
 * Ensure multiple skills are installed concurrently.
 */
export async function ensureSkillsInstalled(skillNames: string[], logger?: Logger): Promise<void> {
  await Promise.all(skillNames.map((name) => ensureSkillInstalled(name, logger)));
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
