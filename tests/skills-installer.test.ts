import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkillFromHub, installSkillsToWorkDir } from '../src/api/skills-installer.js';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
} as any;

let cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

describe('skills installer', () => {
  it('installs hub skills to both Claude and Codex project skill directories', () => {
    const workDir = tempDir('metabot-work-');
    installSkillFromHub(workDir, 'demo-skill', '---\nname: demo-skill\ndescription: Demo\n---\n', undefined, logger);

    expect(readFileSync(join(workDir, '.claude/skills/demo-skill/SKILL.md'), 'utf-8')).toContain('demo-skill');
    expect(readFileSync(join(workDir, '.codex/skills/demo-skill/SKILL.md'), 'utf-8')).toContain('demo-skill');
  });

  it('mirrors user skills into Claude and Codex project directories and deploys AGENTS.md', () => {
    const priorHome = process.env.HOME;
    const home = tempDir('metabot-home-');
    const workDir = tempDir('metabot-work-');
    try {
      process.env.HOME = home;
      mkdirSync(join(home, '.claude/skills/metaskill'), { recursive: true });
      writeFileSync(join(home, '.claude/skills/metaskill/SKILL.md'), '---\nname: metaskill\ndescription: Meta\n---\n');

      installSkillsToWorkDir(workDir, logger);

      expect(readFileSync(join(workDir, '.claude/skills/metaskill/SKILL.md'), 'utf-8')).toContain('metaskill');
      expect(readFileSync(join(workDir, '.codex/skills/metaskill/SKILL.md'), 'utf-8')).toContain('metaskill');
      expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf-8')).toContain('MetaBot Workspace');
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
});
