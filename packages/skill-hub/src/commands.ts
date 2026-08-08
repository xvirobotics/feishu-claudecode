import * as fs from 'node:fs';
import * as path from 'node:path';
import { request } from './client.js';
import type { Config } from './config.js';
import { print } from '@xvirobotics/cli-core/print';
import type { ParsedArgs } from '@xvirobotics/cli-core/args';

export { parseArgs } from '@xvirobotics/cli-core/args';
export type { ParsedArgs } from '@xvirobotics/cli-core/args';

// ---- Commands ----

export async function cmdList(cfg: Config): Promise<void> {
  const body = await request(cfg, { path: '/api/skills' });
  print(body);
}

export async function cmdSearch(cfg: Config, args: ParsedArgs): Promise<void> {
  const q = args.positional[0];
  if (!q) throw new Error('search: <query> required');
  const body = await request(cfg, {
    path: '/api/skills/search',
    query: { q },
  });
  print(body);
}

export async function cmdGet(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('get: <skill name> required');
  const body = await request(cfg, {
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  print(body);
}

interface SkillRecordSnippet {
  name?: string;
  version?: number;
  skillMd?: string;
}

const DEFAULT_SKILL_INSTALL_ROOT = path.join('.metabot', 'skills');
const ENGINE_SKILL_DIRS = new Set(['.claude/skills', '.codex/skills', '.agents/skills']);

function flagEnabled(value: string | true | undefined): boolean {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

export function defaultInstallDir(name: string): string {
  return path.join(DEFAULT_SKILL_INSTALL_ROOT, name);
}

export function targetsEngineAutoloadDir(dir: string): boolean {
  const normalized = path.normalize(dir).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (ENGINE_SKILL_DIRS.has(`${parts[i]}/${parts[i + 1]}`)) return true;
  }
  return false;
}

export async function cmdPublish(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('publish: <skill name> required');

  const from = typeof args.flags.from === 'string' ? args.flags.from : undefined;
  const mdFlag = typeof args.flags.md === 'string' ? args.flags.md : undefined;

  let skillMd: string;
  if (mdFlag) {
    skillMd = fs.readFileSync(mdFlag, 'utf8');
  } else if (from) {
    const p = path.join(from, 'SKILL.md');
    if (!fs.existsSync(p)) throw new Error(`publish: ${p} not found (--from <dir> must contain SKILL.md)`);
    skillMd = fs.readFileSync(p, 'utf8');
  } else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    skillMd = await new Promise<string>((resolve, reject) => {
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()));
      process.stdin.on('error', reject);
    });
  } else {
    throw new Error('publish: provide --from <dir> with SKILL.md, --md <file>, or pipe to stdin');
  }

  const visibility =
    typeof args.flags.visibility === 'string' ? args.flags.visibility : undefined;

  const body = await request<SkillRecordSnippet>(cfg, {
    method: 'POST',
    path: `/api/skills/${encodeURIComponent(name)}/publish`,
    body: { skillMd, visibility },
  });
  print(body);
}

export async function cmdInstall(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('install: <skill name> required');
  const to = typeof args.flags.to === 'string' ? args.flags.to : defaultInstallDir(name);
  const trust = flagEnabled(args.flags.trust) || flagEnabled(args.flags.yes) || flagEnabled(args.flags.y);
  if (targetsEngineAutoloadDir(to) && !trust) {
    throw new Error(
      'install: refusing to write into an engine auto-load skills directory without --trust; '
      + 'install to .metabot/skills first, review SKILL.md, then rerun with --trust if you want the engine to auto-load it',
    );
  }

  const record = await request<SkillRecordSnippet>(cfg, {
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  if (!record.skillMd) {
    throw new Error(`install: ${name} returned no skillMd content`);
  }
  fs.mkdirSync(to, { recursive: true });
  const dst = path.join(to, 'SKILL.md');
  fs.writeFileSync(dst, record.skillMd);
  print({ name, installedTo: dst, version: record.version, trusted: targetsEngineAutoloadDir(to) });
}

export async function cmdRemove(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('remove: <skill name> required');
  const body = await request(cfg, {
    method: 'DELETE',
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  print(body);
}

export async function cmdHealth(cfg: Config): Promise<void> {
  const body = await request(cfg, { path: '/health' });
  print(body);
}

export function printHelp(): void {
  process.stdout.write(
    `metabot skills — metabot-core skill-hub CLI

Usage: metabot skills <command> [args]

Commands:
  list                              List all visible skills
  search <query>                    FTS search over published skills
  get <name>                        Get one skill (includes SKILL.md)
  publish <name>                    Publish a skill. Source order:
                                      --from <dir>   reads <dir>/SKILL.md
                                      --md <file>    reads file
                                      else           reads stdin
                                    Optional: --visibility published|private|shared
  install <name>                    Download SKILL.md to a local review dir
                                      [--to <dir>]   default: .metabot/skills/<name>
                                      [--trust]      required when --to points at .claude/.codex/.agents skills
  remove <name>                     Unpublish a skill
  health
  help

Env:
  METABOT_CORE_URL    default http://localhost:9200
  METABOT_CORE_TOKEN  bearer token (or write to ~/.metabot-core/token)
`,
  );
}
