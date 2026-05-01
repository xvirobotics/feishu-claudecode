import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import { installSkillFromHub } from '../skills-installer.js';

export async function handleSkillHubRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { logger, registry, peerManager } = ctx;
  const store = ctx.skillHubStore;

  if (!url.startsWith('/api/skills')) return false;

  // GET /api/skills/search?q=...
  if (method === 'GET' && url.startsWith('/api/skills/search')) {
    if (!store) { jsonResponse(res, 503, { error: 'Skill Hub not available' }); return true; }
    const params = new URL(url, 'http://localhost').searchParams;
    const query = params.get('q') || '';
    const localResults = store.search(query);
    // Include peer skills if not a peer request
    const isPeer = req.headers['x-metabot-origin'] === 'peer';
    if (!isPeer && peerManager) {
      const peerSkills = peerManager.getPeerSkills?.() ?? [];
      const filtered = query
        ? peerSkills.filter((s) => {
            const q = query.toLowerCase();
            return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q));
          })
        : peerSkills;
      jsonResponse(res, 200, { skills: [...localResults, ...filtered.map((s) => ({ ...s, snippet: '' }))] });
    } else {
      jsonResponse(res, 200, { skills: localResults });
    }
    return true;
  }

  // POST /api/skills/:name/publish-from-bot — publish from a bot's working directory
  if (method === 'POST' && /^\/api\/skills\/[^/]+\/publish-from-bot$/.test(url)) {
    if (!store) { jsonResponse(res, 503, { error: 'Skill Hub not available' }); return true; }
    const skillName = decodeURIComponent(url.split('/')[3]);
    const body = await parseJsonBody(req);
    const botName = body.botName as string;
    if (!botName) {
      jsonResponse(res, 400, { error: 'Missing botName' });
      return true;
    }
    const bot = registry.get(botName);
    if (!bot) {
      jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
      return true;
    }

    const skillDir = [
      path.join(bot.config.claude.defaultWorkingDirectory, '.claude', 'skills', skillName),
      path.join(bot.config.claude.defaultWorkingDirectory, '.codex', 'skills', skillName),
    ].find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')))
      ?? path.join(bot.config.claude.defaultWorkingDirectory, '.claude', 'skills', skillName);
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      jsonResponse(res, 404, { error: `Skill not found at ${skillMdPath}` });
      return true;
    }

    const skillMd = fs.readFileSync(skillMdPath, 'utf-8');

    // Pack references/ directory if it exists
    let referencesTar: Buffer | undefined;
    const refsDir = path.join(skillDir, 'references');
    if (fs.existsSync(refsDir)) {
      try {
        const { execSync } = await import('node:child_process');
        referencesTar = execSync(`tar cf - -C "${skillDir}" references`, { maxBuffer: 50 * 1024 * 1024 });
      } catch (err: any) {
        logger.warn({ err: err.message, skillName }, 'Failed to pack references directory');
      }
    }

    const record = store.publish({ name: skillName, skillMd, referencesTar, author: botName });
    jsonResponse(res, 201, { name: record.name, version: record.version, published: true });
    return true;
  }

  // POST /api/skills/:name/install — install a skill to a bot
  if (method === 'POST' && /^\/api\/skills\/[^/]+\/install$/.test(url)) {
    if (!store) { jsonResponse(res, 503, { error: 'Skill Hub not available' }); return true; }
    const skillName = decodeURIComponent(url.split('/')[3]);
    const body = await parseJsonBody(req);
    const botName = body.botName as string;
    if (!botName) {
      jsonResponse(res, 400, { error: 'Missing botName' });
      return true;
    }
    const bot = registry.get(botName);
    if (!bot) {
      jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
      return true;
    }

    const source = (body.source as string) || 'local';

    let skillMd: string;
    let referencesTar: Buffer | undefined;

    if (source.startsWith('peer:')) {
      // Fetch from peer
      const peerName = source.slice(5);
      if (!peerManager?.fetchPeerSkill) {
        jsonResponse(res, 400, { error: 'Peer manager not available' });
        return true;
      }
      const peerSkill = await peerManager.fetchPeerSkill(peerName, skillName);
      if (!peerSkill) {
        jsonResponse(res, 404, { error: `Skill "${skillName}" not found on peer "${peerName}"` });
        return true;
      }
      skillMd = peerSkill.skillMd;
      referencesTar = peerSkill.referencesTar;
    } else {
      // Fetch from local store
      const content = store.getContent(skillName);
      if (!content) {
        jsonResponse(res, 404, { error: `Skill not found: ${skillName}` });
        return true;
      }
      skillMd = content.skillMd;
      referencesTar = content.referencesTar;
    }

    const workDir = bot.config.claude.defaultWorkingDirectory;
    installSkillFromHub(workDir, skillName, skillMd, referencesTar, logger);
    jsonResponse(res, 200, { installed: true, botName, skillName });
    return true;
  }

  // GET /api/skills/:name — get skill details
  if (method === 'GET' && /^\/api\/skills\/[^/]+$/.test(url)) {
    if (!store) { jsonResponse(res, 503, { error: 'Skill Hub not available' }); return true; }
    const skillName = decodeURIComponent(url.split('/')[3]);
    const record = store.get(skillName);
    if (record) {
      jsonResponse(res, 200, record);
      return true;
    }
    // Try peers
    if (peerManager?.fetchPeerSkill) {
      // Search through peer skills to find which peer has it
      const peerSkills = peerManager.getPeerSkills?.() ?? [];
      const match = peerSkills.find((s) => s.name === skillName);
      if (match) {
        const full = await peerManager.fetchPeerSkill(match.peerName, skillName);
        if (full) {
          jsonResponse(res, 200, { ...full, peerName: match.peerName, peerUrl: match.peerUrl });
          return true;
        }
      }
    }
    jsonResponse(res, 404, { error: `Skill not found: ${skillName}` });
    return true;
  }

  // GET /api/skills — list all skills
  if (method === 'GET' && (url === '/api/skills' || url.startsWith('/api/skills?'))) {
    if (!store) { jsonResponse(res, 503, { error: 'Skill Hub not available' }); return true; }
    const localSkills = store.list();
    const isPeer = req.headers['x-metabot-origin'] === 'peer';
    if (!isPeer && peerManager?.getPeerSkills) {
      const peerSkills = peerManager.getPeerSkills();
      jsonResponse(res, 200, { skills: [...localSkills, ...peerSkills] });
    } else {
      jsonResponse(res, 200, { skills: localSkills });
    }
    return true;
  }

  // POST /api/skills — publish a skill directly
  if (method === 'POST' && url === '/api/skills') {
    if (!store) { jsonResponse(res, 503, { error: 'Skill Hub not available' }); return true; }
    const body = await parseJsonBody(req);
    const skillMd = body.skillMd as string;
    if (!skillMd) {
      jsonResponse(res, 400, { error: 'Missing skillMd' });
      return true;
    }
    const referencesTar = body.referencesTar
      ? Buffer.from(body.referencesTar as string, 'base64')
      : undefined;

    const record = store.publish({
      name: body.name as string || '',
      skillMd,
      referencesTar,
      author: body.author as string,
    });
    jsonResponse(res, 201, { name: record.name, version: record.version, published: true });
    return true;
  }

  // DELETE /api/skills/:name
  if (method === 'DELETE' && /^\/api\/skills\/[^/]+$/.test(url)) {
    if (!store) { jsonResponse(res, 503, { error: 'Skill Hub not available' }); return true; }
    const skillName = decodeURIComponent(url.split('/')[3]);
    const removed = store.remove(skillName);
    if (removed) {
      jsonResponse(res, 200, { name: skillName, removed: true });
    } else {
      jsonResponse(res, 404, { error: `Skill not found: ${skillName}` });
    }
    return true;
  }

  return false;
}
