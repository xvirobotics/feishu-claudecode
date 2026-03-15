import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import type { Logger } from '../utils/logger.js';

/** Skills installed for all platforms. */
const COMMON_SKILLS = ['metaskill', 'metamemory', 'metabot', 'report-bug', 'request-feature', 'fix-issue'];

/** Skills only installed for Feishu bots. */
const FEISHU_SKILLS = ['feishu-doc'];

export interface InstallSkillsOptions {
  /** Bot platform — feishu-only skills are skipped for other platforms. */
  platform?: 'feishu' | 'telegram';
}

export function installSkillsToWorkDir(workDir: string, logger: Logger, options?: InstallSkillsOptions): void {
  const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const destSkillsDir = path.join(workDir, '.claude', 'skills');

  const skillNames = options?.platform === 'feishu'
    ? [...COMMON_SKILLS, ...FEISHU_SKILLS]
    : COMMON_SKILLS;

  for (const skill of skillNames) {
    const src = path.join(userSkillsDir, skill);

    if (!fs.existsSync(src)) {
      logger.debug({ skill }, 'Skill source not found, skipping');
      continue;
    }

    const dest = path.join(destSkillsDir, skill);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    logger.info({ skill, src, dest }, 'Skill installed to working directory');
  }

  // Deploy workspace CLAUDE.md if not already present
  const destClaudeMd = path.join(workDir, 'CLAUDE.md');
  if (!fs.existsSync(destClaudeMd)) {
    const thisFile = url.fileURLToPath(import.meta.url);
    const thisDir = path.dirname(thisFile);
    // Try src/workspace/CLAUDE.md (tsx) or dist/workspace/CLAUDE.md (compiled)
    for (const candidate of [
      path.join(thisDir, '..', 'workspace', 'CLAUDE.md'),
      path.join(thisDir, '..', '..', 'src', 'workspace', 'CLAUDE.md'),
    ]) {
      if (fs.existsSync(candidate)) {
        fs.copyFileSync(candidate, destClaudeMd);
        logger.info({ dest: destClaudeMd }, 'CLAUDE.md deployed to working directory');
        break;
      }
    }
  }
}
