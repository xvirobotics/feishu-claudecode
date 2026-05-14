import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import type { Logger } from '../utils/logger.js';

/** Skills installed for all platforms.
 *
 *  Not in this list (opt-in only):
 *   - `metaskill`     — agent-team generator. Source: src/skills/metaskill/
 *   - `metaschedule`  — MetaBot's persistent server-side scheduler.
 *                       Source: src/skills/metaschedule/
 *
 *  Default ad-hoc scheduling is handled by Claude Code's native `CronCreate`
 *  and `/loop` tools, so the persistent scheduler skill is now opt-in.
 */
const COMMON_SKILLS = ['metamemory', 'metabot', 'phone-call', 'skill-hub'];

/** Lark CLI AI Agent skills — installed via `npx skills add larksuite/cli` and
 *  symlinked into ~/.claude/skills/ automatically. We copy them to the bot
 *  working directory so they are available in the Claude Code session. */
const LARK_CLI_SKILLS = [
  'lark-base', 'lark-calendar', 'lark-contact', 'lark-doc', 'lark-drive',
  'lark-event', 'lark-im', 'lark-mail', 'lark-minutes', 'lark-openapi-explorer',
  'lark-shared', 'lark-sheets', 'lark-skill-maker', 'lark-task', 'lark-vc',
  'lark-whiteboard', 'lark-wiki', 'lark-workflow-meeting-summary',
  'lark-workflow-standup-report',
];

export interface InstallSkillsOptions {
  /** Bot platform — feishu-only skills are skipped for other platforms. */
  platform?: 'feishu' | 'telegram' | 'web' | 'wechat';
  /** Feishu app credentials for lark-cli auto-config (feishu only). */
  feishuAppId?: string;
  feishuAppSecret?: string;
}

export function installSkillsToWorkDir(workDir: string, logger: Logger, options?: InstallSkillsOptions): void {
  const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const destSkillDirs = [
    path.join(workDir, '.claude', 'skills'),
    path.join(workDir, '.codex', 'skills'),
  ];

  const skillNames = options?.platform === 'feishu'
    ? [...COMMON_SKILLS, ...LARK_CLI_SKILLS]
    : COMMON_SKILLS;

  for (const skill of skillNames) {
    const src = fs.existsSync(path.join(userSkillsDir, skill))
      ? path.join(userSkillsDir, skill)
      : bundledSkillSource(skill);

    if (!src || !fs.existsSync(src)) {
      logger.debug({ skill }, 'Skill source not found, skipping');
      continue;
    }

    for (const destSkillsDir of destSkillDirs) {
      const dest = path.join(destSkillsDir, skill);
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      logger.info({ skill, src, dest }, 'Skill installed to working directory');
    }
  }

  // For Feishu bots, ensure lark-cli is configured
  if (options?.platform === 'feishu' && options.feishuAppId && options.feishuAppSecret) {
    ensureLarkCliConfig(options.feishuAppId, options.feishuAppSecret, logger);
  }

  deployWorkspaceInstructions(workDir, logger);
}

/**
 * Ensure lark-cli is configured with Feishu app credentials.
 * Skips if ~/.lark-cli/config.json already exists.
 */
function ensureLarkCliConfig(appId: string, appSecret: string, logger: Logger): void {
  const configPath = path.join(os.homedir(), '.lark-cli', 'config.json');
  if (fs.existsSync(configPath)) {
    logger.debug('lark-cli already configured, skipping');
    return;
  }

  // Find lark-cli binary
  const larkCliBin = findLarkCli();
  if (!larkCliBin) {
    logger.warn('lark-cli not found in PATH or ~/.npm-global/bin — skipping config. Run: npm install -g @larksuite/cli');
    return;
  }

  try {
    execFileSync(larkCliBin, ['config', 'init', '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'], {
      input: appSecret,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    logger.info({ appId }, 'lark-cli configured successfully');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to configure lark-cli — you can run manually: lark-cli config init');
  }
}

/**
 * Install a skill from the Skill Hub into a bot's working directory.
 * Writes SKILL.md and optionally extracts references/ from a tar buffer.
 */
export function installSkillFromHub(
  workDir: string,
  skillName: string,
  skillMd: string,
  referencesTar: Buffer | undefined,
  logger: Logger,
): void {
  const destDirs = [
    path.join(workDir, '.claude', 'skills', skillName),
    path.join(workDir, '.codex', 'skills', skillName),
  ];

  for (const destDir of destDirs) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'SKILL.md'), skillMd, 'utf-8');

    if (referencesTar && referencesTar.length > 0) {
      try {
        execSync(`tar xf - -C "${destDir}"`, { input: referencesTar, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      } catch (err: any) {
        logger.warn({ err: err.message, skillName, destDir }, 'Failed to extract references tar');
      }
    }

    logger.info({ skillName, dest: destDir }, 'Skill installed from Hub');
  }
}

function deployWorkspaceInstructions(workDir: string, logger: Logger): void {
  const thisFile = url.fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  const existingClaudeMd = path.join(workDir, 'CLAUDE.md');
  for (const candidate of [
    path.join(thisDir, '..', 'workspace', 'CLAUDE.md'),
    path.join(thisDir, '..', '..', 'src', 'workspace', 'CLAUDE.md'),
  ]) {
    if (!fs.existsSync(candidate)) continue;

    copyInstructionFile(candidate, existingClaudeMd, 'CLAUDE.md', logger);
    copyInstructionFile(fs.existsSync(existingClaudeMd) ? existingClaudeMd : candidate, path.join(workDir, 'AGENTS.md'), 'AGENTS.md', logger);
    break;
  }
}

function bundledSkillSource(skill: string): string | undefined {
  const thisFile = url.fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  const candidatesBySkill: Record<string, string[]> = {
    // metaskill / metaschedule are opt-in: not in COMMON_SKILLS, but bundled
    // here so users who copy them into `~/.claude/skills/` get the source
    // resolved correctly if they later install a bot with installSkills:true.
    metaskill: [
      path.join(thisDir, '..', 'skills', 'metaskill'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'metaskill'),
    ],
    metaschedule: [
      path.join(thisDir, '..', 'skills', 'metaschedule'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'metaschedule'),
    ],
    metamemory: [
      path.join(thisDir, '..', 'memory', 'skill'),
      path.join(thisDir, '..', '..', 'src', 'memory', 'skill'),
    ],
    metabot: [
      path.join(thisDir, '..', 'skills', 'metabot'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'metabot'),
    ],
    voice: [
      path.join(thisDir, '..', 'skills', 'voice'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'voice'),
    ],
    'skill-hub': [
      path.join(thisDir, '..', 'skills', 'skill-hub'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'skill-hub'),
    ],
  };
  return candidatesBySkill[skill]?.find((candidate) => fs.existsSync(candidate));
}

function copyInstructionFile(src: string, dest: string, fileName: string, logger: Logger): void {
  if (fs.existsSync(dest)) return;
  try {
    fs.copyFileSync(src, dest);
    logger.info({ dest }, `${fileName} deployed to working directory`);
  } catch (err: any) {
    logger.warn({ err: err.message, src, dest }, `Failed to deploy ${fileName}`);
  }
}

/** Locate the lark-cli executable. */
function findLarkCli(): string | null {
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'bin', 'lark-cli'),
    '/usr/local/bin/lark-cli',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Try PATH via which
  try {
    const result = execFileSync('which', ['lark-cli'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5_000 });
    const p = result.toString().trim();
    if (p) return p;
  } catch { /* not in PATH */ }
  return null;
}
