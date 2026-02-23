import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

const SKILL_NAMES = ['metaskill', 'metamemory'];

export function installSkillsToWorkDir(workDir: string, logger: Logger): void {
  const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const destSkillsDir = path.join(workDir, '.claude', 'skills');

  for (const skill of SKILL_NAMES) {
    const src = path.join(userSkillsDir, skill);
    if (!fs.existsSync(src)) {
      logger.debug({ skill, src }, 'Skill source not found, skipping');
      continue;
    }

    const dest = path.join(destSkillsDir, skill);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    logger.info({ skill, dest }, 'Skill installed to working directory');
  }
}
