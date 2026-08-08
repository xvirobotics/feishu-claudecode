import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Logger } from '../utils/logger.js';

/** Historical project mirrors retired by the installer. */
const PROJECT_METABOT_SKILL_MIRRORS = ['metabot', 'metabot-team', 'voice'];

/** Lark CLI Skills remain user-managed and may be mirrored into a workspace. */
const LARK_CLI_SKILLS = [
  'lark-approval',
  'lark-apps',
  'lark-attendance',
  'lark-base',
  'lark-calendar',
  'lark-contact',
  'lark-doc',
  'lark-drive',
  'lark-event',
  'lark-im',
  'lark-mail',
  'lark-markdown',
  'lark-minutes',
  'lark-note',
  'lark-okr',
  'lark-openapi-explorer',
  'lark-shared',
  'lark-sheets',
  'lark-skill-maker',
  'lark-slides',
  'lark-task',
  'lark-vc',
  'lark-vc-agent',
  'lark-whiteboard',
  'lark-wiki',
  'lark-workflow-meeting-summary',
  'lark-workflow-standup-report',
];

const DEFAULT_LARK_CLI_SKILLS = ['lark-shared', 'lark-im', 'lark-doc'];
const OBSOLETE_WORKSPACE_HARNESS_STATE = path.join('.metabot', 'workspace-harness.sha256');

function selectedLarkSkills(profile = process.env.METABOT_LARK_SKILLS || 'minimal'): string[] {
  if (profile === '' || profile === 'minimal') return DEFAULT_LARK_CLI_SKILLS;
  if (profile === 'all') return LARK_CLI_SKILLS;
  if (profile === 'none') return [];

  const selected = profile.split(',').filter(Boolean);
  const unknown = selected.find((skill) => !LARK_CLI_SKILLS.includes(skill));
  if (unknown) {
    throw new Error(
      `Unknown Lark skill in METABOT_LARK_SKILLS: ${unknown}. Use minimal, all, none, or known comma-separated lark-* skills.`,
    );
  }
  return selected;
}

export interface InstallSkillsOptions {
  /** Bot platform — Feishu-only Skills are skipped for other platforms. */
  platform?: 'feishu' | 'telegram' | 'web' | 'wechat' | 'slack';
  /** Feishu app credentials for optional lark-cli auto-config. */
  feishuAppId?: string;
  feishuAppSecret?: string;
}

export function installSkillsToWorkDir(workDir: string, logger: Logger, options?: InstallSkillsOptions): void {
  const canonicalSkillsDir = path.join(os.homedir(), '.agents', 'skills');
  const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const destSkillDirs = [
    path.join(workDir, '.claude', 'skills'),
    path.join(workDir, '.codex', 'skills'),
    path.join(workDir, '.agents', 'skills'),
  ];

  const selectedLark = options?.platform === 'feishu' ? selectedLarkSkills() : [];
  const backupRoot = path.join(workDir, '.metabot', 'skill-backups');

  // MetaBot-owned Skills are user-global. Retire project mirrors so an old
  // workspace snapshot cannot shadow a newer global Skill. Backups stay
  // outside discovery roots and preserve local edits.
  for (const destSkillsDir of destSkillDirs) {
    for (const skill of PROJECT_METABOT_SKILL_MIRRORS) {
      const dest = path.join(destSkillsDir, skill);
      if (!pathEntryExists(dest)) continue;
      backupExistingSkill(dest, backupRoot);
      logger.info({ skill, dest }, 'Project-level MetaBot Skill mirror retired');
    }
  }

  // Workspace instructions are user-owned. Remove only obsolete bookkeeping;
  // leave AGENTS.md and CLAUDE.md untouched.
  fs.rmSync(path.join(workDir, OBSOLETE_WORKSPACE_HARNESS_STATE), { force: true });

  for (const skill of selectedLark) {
    const canonicalLarkSource = path.join(canonicalSkillsDir, skill);
    const src = fs.existsSync(canonicalLarkSource)
      ? canonicalLarkSource
      : fs.existsSync(path.join(userSkillsDir, skill))
        ? path.join(userSkillsDir, skill)
        : undefined;

    if (!src || !fs.existsSync(src)) {
      logger.debug({ skill }, 'Skill source not found, skipping');
      continue;
    }

    for (const destSkillsDir of destSkillDirs) {
      const dest = path.join(destSkillsDir, skill);
      syncManagedSkill(src, dest, backupRoot);
      logger.info({ skill, src, dest }, 'Skill installed to working directory');
    }
  }

  if (options?.platform === 'feishu') {
    for (const skill of LARK_CLI_SKILLS) {
      if (selectedLark.includes(skill)) continue;
      const canonical = path.join(canonicalSkillsDir, skill);
      for (const destSkillsDir of destSkillDirs) {
        const dest = path.join(destSkillsDir, skill);
        if (directoriesEqual(canonical, dest)) {
          backupExistingSkill(dest, backupRoot);
          logger.info({ skill, dest }, 'Unselected canonical Lark Skill mirror retired');
        } else if (fs.existsSync(dest)) {
          logger.warn({ skill, dest }, 'Preserved locally modified unselected Lark Skill');
        }
      }
    }
  }

  if (options?.platform === 'feishu' && options.feishuAppId && options.feishuAppSecret) {
    ensureLarkCliConfig(options.feishuAppId, options.feishuAppSecret, logger);
  }
}

function ensureLarkCliConfig(appId: string, appSecret: string, logger: Logger): void {
  const configPath = path.join(os.homedir(), '.lark-cli', 'config.json');
  if (fs.existsSync(configPath)) {
    logger.debug('lark-cli already configured, skipping');
    return;
  }

  const larkCliBin = findLarkCli();
  if (!larkCliBin) {
    logger.warn(
      'lark-cli not found in PATH or ~/.npm-global/bin — skipping config. Run: npm install -g @larksuite/cli',
    );
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

function directoriesEqual(left: string, right: string): boolean {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const entries = (root: string): string[] => {
    const files: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) files.push(path.relative(root, absolute));
      }
    };
    visit(root);
    return files.sort();
  };
  const leftFiles = entries(left);
  const rightFiles = entries(right);
  if (leftFiles.length !== rightFiles.length || leftFiles.some((file, index) => file !== rightFiles[index])) {
    return false;
  }
  return leftFiles.every((file) =>
    fs.readFileSync(path.join(left, file)).equals(fs.readFileSync(path.join(right, file))),
  );
}

function backupExistingSkill(destination: string, backupRoot: string): void {
  if (!pathEntryExists(destination)) return;
  fs.mkdirSync(backupRoot, { recursive: true });
  const backup = fs.mkdtempSync(path.join(backupRoot, `${path.basename(destination)}.`));
  fs.rmdirSync(backup);
  fs.renameSync(destination, backup);
}

function syncManagedSkill(source: string, destination: string, backupRoot: string): void {
  if (directoriesEqual(source, destination)) return;
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(destination)}.staging.`));
  let backup: string | undefined;
  try {
    fs.cpSync(source, staging, { recursive: true });
    if (pathEntryExists(destination)) {
      fs.mkdirSync(backupRoot, { recursive: true });
      backup = fs.mkdtempSync(path.join(backupRoot, `${path.basename(destination)}.`));
      fs.rmdirSync(backup);
      fs.renameSync(destination, backup);
    }
    fs.renameSync(staging, destination);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (backup && !pathEntryExists(destination) && pathEntryExists(backup)) {
      fs.renameSync(backup, destination);
    }
    throw err;
  }
}

function pathEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function findLarkCli(): string | null {
  const candidates = [path.join(os.homedir(), '.npm-global', 'bin', 'lark-cli'), '/usr/local/bin/lark-cli'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const result = execFileSync('which', ['lark-cli'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5_000 });
    const executable = result.toString().trim();
    if (executable) return executable;
  } catch {
    // Not on PATH.
  }
  return null;
}
