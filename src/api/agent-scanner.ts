/**
 * Agent Scanner — reads .claude/agents/*.md from bot working directories
 * and extracts YAML frontmatter metadata for each sub-agent.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AgentMetadata {
  name: string;
  description?: string;
  model?: string;
  tools?: string;
}

/**
 * Scan a directory's .claude/agents/ folder and parse agent metadata.
 * Returns empty array if no agents found or directory doesn't exist.
 */
export async function scanAgents(workingDirectory: string): Promise<AgentMetadata[]> {
  const agentsDir = join(workingDirectory, '.claude', 'agents');
  const agents: AgentMetadata[] = [];

  let files: string[];
  try {
    files = await readdir(agentsDir);
  } catch {
    return agents;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const content = await readFile(join(agentsDir, file), 'utf-8');
      const meta = parseFrontmatter(content);
      if (meta.name) {
        agents.push(meta);
      }
    } catch {
      // skip unreadable files
    }
  }

  return agents;
}

/** Parse YAML frontmatter from a markdown file. Simple key: value parser. */
function parseFrontmatter(content: string): AgentMetadata {
  const meta: AgentMetadata = { name: '' };
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return meta;

  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'name') meta.name = value;
    else if (key === 'description') meta.description = value;
    else if (key === 'model') meta.model = value;
    else if (key === 'tools') meta.tools = value;
  }

  return meta;
}

/**
 * Cache for agent metadata. Scanned once at startup, refreshed on demand.
 */
const agentCache = new Map<string, { agents: AgentMetadata[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getAgents(workingDirectory: string): Promise<AgentMetadata[]> {
  const cached = agentCache.get(workingDirectory);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.agents;
  }
  const agents = await scanAgents(workingDirectory);
  agentCache.set(workingDirectory, { agents, timestamp: Date.now() });
  return agents;
}
