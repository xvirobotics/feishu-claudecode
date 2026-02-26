import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import type { Logger } from '../utils/logger.js';

const SKILL_NAMES = ['metaskill', 'metamemory', 'metabot'];

export function installSkillsToWorkDir(workDir: string, logger: Logger): void {
  const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const destSkillsDir = path.join(workDir, '.claude', 'skills');

  for (const skill of SKILL_NAMES) {
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
