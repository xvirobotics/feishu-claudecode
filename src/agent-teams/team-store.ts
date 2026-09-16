import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EngineName } from '../engines/types.js';
import type { Logger } from '../utils/logger.js';

export type TeamStatus = 'active' | 'stopped';
export type AgentStatus = 'idle' | 'working' | 'stopped';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface AgentTeam {
  name: string;
  description?: string;
  status: TeamStatus;
  chatIds: string[];
  displayChatIds: string[];
  managedByConfig: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TeamAgent {
  teamName: string;
  name: string;
  role?: string;
  engine?: EngineName;
  prompt?: string;
  status: AgentStatus;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamTask {
  teamName: string;
  id: number;
  subject: string;
  description?: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: number[];
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMessage {
  id: number;
  teamName: string;
  fromName?: string;
  toName: string;
  summary?: string;
  body: string;
  readAt?: number;
  createdAt: number;
}

export interface TeamRun {
  id: string;
  teamName: string;
  agentName?: string;
  taskId?: number;
  status: RunStatus;
  output?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export interface AgentTeamConfig {
  name: string;
  description?: string;
  status?: TeamStatus;
  chatIds?: string[];
  displayChatIds?: string[];
  agents?: Array<{
    name: string;
    role?: string;
    engine?: EngineName;
    prompt?: string;
    sessionId?: string;
    status?: AgentStatus;
  }>;
  tasks?: Array<{
    id?: number;
    subject: string;
    description?: string;
    owner?: string;
    blockedBy?: number[];
    status?: TaskStatus;
    result?: string;
  }>;
}

export class AgentTeamStore {
  private readonly db: Database.Database;
  /**
   * Set once close() runs. Read accessors short-circuit to "no data" so a
   * turn that is still finalizing during shutdown doesn't throw
   * "The database connection is not open".
   */
  private closed = false;

  constructor(logger: Logger, dbPath?: string) {
    const dataDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    const finalPath = dbPath || path.join(dataDir, 'agent-teams.db');
    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    logger.child({ module: 'agent-team-store' }).info({ dbPath: finalPath }, 'Agent team store initialized');
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_teams (
        name TEXT PRIMARY KEY,
        description TEXT,
        status TEXT NOT NULL,
        chat_ids TEXT NOT NULL DEFAULT '[]',
        display_chat_ids TEXT NOT NULL DEFAULT '[]',
        managed_by_config INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_team_agents (
        team_name TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT,
        engine TEXT,
        prompt TEXT,
        status TEXT NOT NULL,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (team_name, name),
        FOREIGN KEY (team_name) REFERENCES agent_teams(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_team_tasks (
        team_name TEXT NOT NULL,
        id INTEGER NOT NULL,
        subject TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        owner TEXT,
        blocked_by TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (team_name, id),
        FOREIGN KEY (team_name) REFERENCES agent_teams(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_team_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_name TEXT NOT NULL,
        from_name TEXT,
        to_name TEXT NOT NULL,
        summary TEXT,
        body TEXT NOT NULL,
        read_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (team_name) REFERENCES agent_teams(name) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_team_messages_inbox
        ON agent_team_messages(team_name, to_name, read_at, created_at);

      CREATE TABLE IF NOT EXISTS agent_team_runs (
        id TEXT PRIMARY KEY,
        team_name TEXT NOT NULL,
        agent_name TEXT,
        task_id INTEGER,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (team_name) REFERENCES agent_teams(name) ON DELETE CASCADE
      );
    `);
    this.addColumnIfMissing('agent_teams', 'chat_ids', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('agent_teams', 'display_chat_ids', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('agent_teams', 'managed_by_config', 'INTEGER NOT NULL DEFAULT 0');
  }

  createTeam(name: string, description?: string, options?: { chatIds?: string[]; displayChatIds?: string[]; status?: TeamStatus }): AgentTeam {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_teams (name, description, status, chat_ids, display_chat_ids, managed_by_config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      name,
      description ?? null,
      options?.status ?? 'active',
      JSON.stringify(normalizeStringArray(options?.chatIds)),
      JSON.stringify(normalizeStringArray(options?.displayChatIds)),
      now,
      now,
    );
    return this.getTeam(name)!;
  }

  upsertTeam(input: AgentTeamConfig): AgentTeam {
    const existing = this.getTeam(input.name);
    const now = Date.now();
    const chatIds = normalizeStringArray(input.chatIds ?? existing?.chatIds);
    const displayChatIds = normalizeStringArray(input.displayChatIds ?? existing?.displayChatIds);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO agent_teams (name, description, status, chat_ids, display_chat_ids, managed_by_config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.name,
        input.description ?? null,
        input.status ?? 'active',
        JSON.stringify(chatIds),
        JSON.stringify(displayChatIds),
        now,
        now,
      );
    } else {
      this.db.prepare(`
        UPDATE agent_teams
        SET description = ?, status = ?, chat_ids = ?, display_chat_ids = ?, managed_by_config = 1, updated_at = ?
        WHERE name = ?
      `).run(
        input.description ?? existing.description ?? null,
        input.status ?? existing.status,
        JSON.stringify(chatIds),
        JSON.stringify(displayChatIds),
        now,
        input.name,
      );
    }
    return this.getTeam(input.name)!;
  }

  reconcileTeams(configs: AgentTeamConfig[]): void {
    const names = new Set<string>();
    for (const config of configs) {
      if (!config.name) continue;
      names.add(config.name);
      this.upsertTeam(config);
      for (const agent of config.agents ?? []) {
        this.upsertAgent(config.name, agent);
      }
      for (const task of config.tasks ?? []) {
        this.upsertTask(config.name, task);
      }
    }
    for (const team of this.listTeams()) {
      if (!names.has(team.name)) {
        if (team.managedByConfig && team.status !== 'stopped') this.setTeamStatus(team.name, 'stopped');
        continue;
      }
      const desiredAgents = new Set((configs.find((cfg) => cfg.name === team.name)?.agents ?? []).map((agent) => agent.name));
      for (const agent of this.listAgents(team.name)) {
        if (desiredAgents.size > 0 && !desiredAgents.has(agent.name) && agent.status !== 'stopped') {
          this.setAgentStatus(team.name, agent.name, 'stopped');
        }
      }
    }
  }

  listTeams(): AgentTeam[] {
    if (this.closed) return [];
    const rows = this.db.prepare('SELECT * FROM agent_teams ORDER BY updated_at DESC').all() as any[];
    return rows.map((row) => this.rowToTeam(row));
  }

  getTeam(name: string): AgentTeam | undefined {
    if (this.closed) return undefined;
    const row = this.db.prepare('SELECT * FROM agent_teams WHERE name = ?').get(name) as any;
    return row ? this.rowToTeam(row) : undefined;
  }

  deleteTeam(name: string): boolean {
    return this.db.prepare('DELETE FROM agent_teams WHERE name = ?').run(name).changes > 0;
  }

  deleteAgent(teamName: string, name: string): boolean {
    return this.db.prepare('DELETE FROM agent_team_agents WHERE team_name = ? AND name = ?').run(teamName, name).changes > 0;
  }

  setTeamStatus(name: string, status: TeamStatus): AgentTeam | undefined {
    const now = Date.now();
    this.db.prepare('UPDATE agent_teams SET status = ?, updated_at = ? WHERE name = ?').run(status, now, name);
    return this.getTeam(name);
  }

  setTeamChatBindings(name: string, input: {
    chatIds?: string[];
    displayChatIds?: string[];
  }): AgentTeam | undefined {
    const existing = this.getTeam(name);
    if (!existing) return undefined;
    const now = Date.now();
    this.db.prepare(`
      UPDATE agent_teams SET chat_ids = ?, display_chat_ids = ?, updated_at = ?
      WHERE name = ?
    `).run(
      JSON.stringify(input.chatIds === undefined ? existing.chatIds : normalizeStringArray(input.chatIds)),
      JSON.stringify(input.displayChatIds === undefined ? existing.displayChatIds : normalizeStringArray(input.displayChatIds)),
      now,
      name,
    );
    return this.getTeam(name);
  }

  createAgent(teamName: string, input: {
    name: string;
    role?: string;
    engine?: EngineName;
    prompt?: string;
    sessionId?: string;
  }): TeamAgent {
    this.requireTeam(teamName);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_team_agents
        (team_name, name, role, engine, prompt, status, session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)
    `).run(
      teamName,
      input.name,
      input.role ?? null,
      input.engine ?? null,
      input.prompt ?? null,
      input.sessionId ?? null,
      now,
      now,
    );
    return {
      teamName,
      name: input.name,
      ...(input.role ? { role: input.role } : {}),
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      status: 'idle',
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  upsertAgent(teamName: string, input: {
    name: string;
    role?: string;
    engine?: EngineName;
    prompt?: string;
    sessionId?: string;
    status?: AgentStatus;
  }): TeamAgent {
    this.requireTeam(teamName);
    const existing = this.getAgent(teamName, input.name);
    const now = Date.now();
    if (!existing) {
      this.db.prepare(`
        INSERT INTO agent_team_agents
          (team_name, name, role, engine, prompt, status, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        teamName,
        input.name,
        input.role ?? null,
        input.engine ?? null,
        input.prompt ?? null,
        input.status ?? 'idle',
        input.sessionId ?? null,
        now,
        now,
      );
    } else {
      this.db.prepare(`
        UPDATE agent_team_agents
        SET role = ?, engine = ?, prompt = ?, status = ?, session_id = ?, updated_at = ?
        WHERE team_name = ? AND name = ?
      `).run(
        input.role ?? existing.role ?? null,
        input.engine ?? existing.engine ?? null,
        input.prompt ?? existing.prompt ?? null,
        input.status ?? (existing.status === 'stopped' ? 'idle' : existing.status),
        input.sessionId ?? existing.sessionId ?? null,
        now,
        teamName,
        input.name,
      );
    }
    return this.getAgent(teamName, input.name)!;
  }

  listAgents(teamName: string): TeamAgent[] {
    this.requireTeam(teamName);
    const rows = this.db.prepare('SELECT * FROM agent_team_agents WHERE team_name = ? ORDER BY created_at ASC').all(teamName) as any[];
    return rows.map((row) => this.rowToAgent(row));
  }

  getAgent(teamName: string, name: string): TeamAgent | undefined {
    const row = this.db.prepare('SELECT * FROM agent_team_agents WHERE team_name = ? AND name = ?').get(teamName, name) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  setAgentStatus(teamName: string, name: string, status: AgentStatus): TeamAgent | undefined {
    const now = Date.now();
    this.db.prepare('UPDATE agent_team_agents SET status = ?, updated_at = ? WHERE team_name = ? AND name = ?')
      .run(status, now, teamName, name);
    const row = this.db.prepare('SELECT * FROM agent_team_agents WHERE team_name = ? AND name = ?').get(teamName, name) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  setAgentSessionId(teamName: string, name: string, sessionId: string | undefined, engine?: EngineName): TeamAgent | undefined {
    const existing = this.getAgent(teamName, name);
    if (!existing) return undefined;
    const now = Date.now();
    this.db.prepare(`
      UPDATE agent_team_agents
      SET session_id = ?, engine = ?, updated_at = ?
      WHERE team_name = ? AND name = ?
    `).run(sessionId ?? null, engine ?? existing.engine ?? null, now, teamName, name);
    return this.getAgent(teamName, name);
  }

  createTask(teamName: string, input: {
    subject: string;
    description?: string;
    owner?: string;
    blockedBy?: number[];
  }): TeamTask {
    this.requireTeam(teamName);
    const nextId = ((this.db.prepare('SELECT MAX(id) AS max_id FROM agent_team_tasks WHERE team_name = ?').get(teamName) as any)?.max_id ?? 0) + 1;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_team_tasks
        (team_name, id, subject, description, status, owner, blocked_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      teamName,
      nextId,
      input.subject,
      input.description ?? null,
      input.owner ?? null,
      JSON.stringify(input.blockedBy ?? []),
      now,
      now,
    );
    return this.getTask(teamName, nextId)!;
  }

  upsertTask(teamName: string, input: {
    id?: number;
    subject: string;
    description?: string;
    owner?: string;
    blockedBy?: number[];
    status?: TaskStatus;
    result?: string;
  }): TeamTask {
    if (input.id != null) {
      const existing = this.getTask(teamName, input.id);
      if (existing) {
        return this.updateTask(teamName, input.id, {
          subject: input.subject,
          description: input.description,
          status: input.status ?? existing.status,
          owner: input.owner,
          blockedBy: input.blockedBy,
          result: input.result,
        })!;
      }
      const now = Date.now();
      this.requireTeam(teamName);
      this.db.prepare(`
        INSERT INTO agent_team_tasks
          (team_name, id, subject, description, status, owner, blocked_by, result, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        teamName,
        input.id,
        input.subject,
        input.description ?? null,
        input.status ?? 'pending',
        input.owner ?? null,
        JSON.stringify(input.blockedBy ?? []),
        input.result ?? null,
        now,
        now,
      );
      return this.getTask(teamName, input.id)!;
    }
    return this.createTask(teamName, {
      subject: input.subject,
      description: input.description,
      owner: input.owner,
      blockedBy: input.blockedBy,
    });
  }

  findTeamForChat(chatId: string): AgentTeam | undefined {
    const teams = this.listTeams().filter((team) => team.status === 'active');
    return teams.find((team) => team.displayChatIds.includes(chatId))
      ?? teams.find((team) => team.chatIds.includes(chatId));
  }

  listTasks(teamName: string): TeamTask[] {
    this.requireTeam(teamName);
    const rows = this.db.prepare('SELECT * FROM agent_team_tasks WHERE team_name = ? AND status != ? ORDER BY id ASC')
      .all(teamName, 'deleted') as any[];
    return rows.map((row) => this.rowToTask(row));
  }

  getTask(teamName: string, id: number): TeamTask | undefined {
    const row = this.db.prepare('SELECT * FROM agent_team_tasks WHERE team_name = ? AND id = ?').get(teamName, id) as any;
    return row ? this.rowToTask(row) : undefined;
  }

  updateTask(teamName: string, id: number, input: {
    subject?: string;
    description?: string;
    status?: TaskStatus;
    owner?: string | null;
    blockedBy?: number[];
    result?: string;
  }): TeamTask | undefined {
    const existing = this.getTask(teamName, id);
    if (!existing) return undefined;
    const now = Date.now();
    this.db.prepare(`
      UPDATE agent_team_tasks
      SET subject = ?, description = ?, status = ?, owner = ?, blocked_by = ?, result = ?, updated_at = ?
      WHERE team_name = ? AND id = ?
    `).run(
      input.subject ?? existing.subject,
      input.description ?? existing.description ?? null,
      input.status ?? existing.status,
      input.owner === undefined ? existing.owner ?? null : input.owner,
      JSON.stringify(input.blockedBy ?? existing.blockedBy),
      input.result ?? existing.result ?? null,
      now,
      teamName,
      id,
    );
    return this.getTask(teamName, id);
  }

  sendMessage(teamName: string, input: {
    toName: string;
    body: string;
    fromName?: string;
    summary?: string;
  }): TeamMessage {
    this.requireTeam(teamName);
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO agent_team_messages (team_name, from_name, to_name, summary, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(teamName, input.fromName ?? null, input.toName, input.summary ?? null, input.body, now);
    return this.getMessage(Number(result.lastInsertRowid))!;
  }

  listMessages(teamName: string, toName?: string, unreadOnly = false): TeamMessage[] {
    this.requireTeam(teamName);
    const clauses = ['team_name = ?'];
    const args: unknown[] = [teamName];
    if (toName) {
      clauses.push('to_name = ?');
      args.push(toName);
    }
    if (unreadOnly) clauses.push('read_at IS NULL');
    const rows = this.db.prepare(`
      SELECT * FROM agent_team_messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at ASC
    `).all(...args) as any[];
    return rows.map((row) => this.rowToMessage(row));
  }

  markMessagesRead(teamName: string, toName: string): number {
    const result = this.db.prepare(`
      UPDATE agent_team_messages SET read_at = ?
      WHERE team_name = ? AND to_name = ? AND read_at IS NULL
    `).run(Date.now(), teamName, toName);
    return result.changes;
  }

  markMessagesReadById(teamName: string, toName: string, ids: number[]): number {
    this.requireTeam(teamName);
    const messageIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
    if (messageIds.length === 0) return 0;
    const placeholders = messageIds.map(() => '?').join(', ');
    const result = this.db.prepare(`
      UPDATE agent_team_messages SET read_at = ?
      WHERE team_name = ? AND to_name = ? AND read_at IS NULL AND id IN (${placeholders})
    `).run(Date.now(), teamName, toName, ...messageIds);
    return result.changes;
  }

  createRun(teamName: string, input: {
    id?: string;
    agentName?: string;
    taskId?: number;
    status?: RunStatus;
    output?: string;
    error?: string;
  }): TeamRun {
    this.requireTeam(teamName);
    const now = Date.now();
    const id = input.id || `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO agent_team_runs (id, team_name, agent_name, task_id, status, output, error, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      teamName,
      input.agentName ?? null,
      input.taskId ?? null,
      input.status ?? 'running',
      input.output ?? null,
      input.error ?? null,
      now,
      now,
    );
    return this.getRun(teamName, id)!;
  }

  listRuns(teamName: string): TeamRun[] {
    this.requireTeam(teamName);
    const rows = this.db.prepare('SELECT * FROM agent_team_runs WHERE team_name = ? ORDER BY started_at DESC').all(teamName) as any[];
    return rows.map((row) => this.rowToRun(row));
  }

  getRunningRun(teamName: string, agentName: string): TeamRun | undefined {
    this.requireTeam(teamName);
    const row = this.db.prepare(`
      SELECT * FROM agent_team_runs
      WHERE team_name = ? AND agent_name = ? AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `).get(teamName, agentName) as any;
    return row ? this.rowToRun(row) : undefined;
  }

  getRun(teamName: string, id: string): TeamRun | undefined {
    const row = this.db.prepare('SELECT * FROM agent_team_runs WHERE team_name = ? AND id = ?').get(teamName, id) as any;
    return row ? this.rowToRun(row) : undefined;
  }

  updateRun(teamName: string, id: string, input: {
    status?: RunStatus;
    output?: string;
    error?: string;
  }): TeamRun | undefined {
    const existing = this.getRun(teamName, id);
    if (!existing) return undefined;
    this.db.prepare(`
      UPDATE agent_team_runs SET status = ?, output = ?, error = ?, updated_at = ?
      WHERE team_name = ? AND id = ?
    `).run(
      input.status ?? existing.status,
      input.output ?? existing.output ?? null,
      input.error ?? existing.error ?? null,
      Date.now(),
      teamName,
      id,
    );
    return this.getRun(teamName, id);
  }

  appendRunOutput(teamName: string, id: string, output: string): TeamRun | undefined {
    const existing = this.getRun(teamName, id);
    if (!existing) return undefined;
    if (existing.status !== 'running') return existing;
    const nextOutput = mergeOutput(existing.output, output);
    return this.updateRun(teamName, id, { output: nextOutput });
  }

  status(teamName: string): {
    team: AgentTeam;
    agents: TeamAgent[];
    tasks: TeamTask[];
    unreadMessages: number;
    runs: TeamRun[];
  } | undefined {
    const team = this.getTeam(teamName);
    if (!team) return undefined;
    return {
      team,
      agents: this.listAgents(teamName),
      tasks: this.listTasks(teamName),
      unreadMessages: this.listMessages(teamName, undefined, true).length,
      runs: this.listRuns(teamName),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** True after close(); callers can skip store reads during shutdown. */
  isClosed(): boolean {
    return this.closed;
  }

  private requireTeam(teamName: string): void {
    if (!this.getTeam(teamName)) {
      throw Object.assign(new Error(`Agent team not found: ${teamName}`), { statusCode: 404 });
    }
  }

  private getMessage(id: number): TeamMessage | undefined {
    const row = this.db.prepare('SELECT * FROM agent_team_messages WHERE id = ?').get(id) as any;
    return row ? this.rowToMessage(row) : undefined;
  }

  private rowToTeam(row: any): AgentTeam {
    return {
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      status: row.status,
      chatIds: parseJsonStringArray(row.chat_ids),
      displayChatIds: parseJsonStringArray(row.display_chat_ids),
      managedByConfig: !!row.managed_by_config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToAgent(row: any): TeamAgent {
    return {
      teamName: row.team_name,
      name: row.name,
      ...(row.role ? { role: row.role } : {}),
      ...(row.engine ? { engine: row.engine } : {}),
      ...(row.prompt ? { prompt: row.prompt } : {}),
      status: row.status,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTask(row: any): TeamTask {
    return {
      teamName: row.team_name,
      id: row.id,
      subject: row.subject,
      ...(row.description ? { description: row.description } : {}),
      status: row.status,
      ...(row.owner ? { owner: row.owner } : {}),
      blockedBy: parseJsonNumberArray(row.blocked_by),
      ...(row.result ? { result: row.result } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToMessage(row: any): TeamMessage {
    return {
      id: row.id,
      teamName: row.team_name,
      ...(row.from_name ? { fromName: row.from_name } : {}),
      toName: row.to_name,
      ...(row.summary ? { summary: row.summary } : {}),
      body: row.body,
      ...(row.read_at ? { readAt: row.read_at } : {}),
      createdAt: row.created_at,
    };
  }

  private rowToRun(row: any): TeamRun {
    return {
      id: row.id,
      teamName: row.team_name,
      ...(row.agent_name ? { agentName: row.agent_name } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      status: row.status,
      ...(row.output ? { output: row.output } : {}),
      ...(row.error ? { error: row.error } : {}),
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    };
  }

  private addColumnIfMissing(table: string, name: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function parseJsonNumberArray(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return normalizeStringArray(parsed);
  } catch {
    return [];
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())));
}

function mergeOutput(existing: string | undefined, next: string): string {
  const trimmed = next.trim();
  if (!trimmed) return existing ?? '';
  if (!existing) return trimmed;
  if (trimmed.startsWith(existing)) return trimmed;
  if (existing.endsWith(trimmed)) return existing;
  return `${existing}\n${trimmed}`;
}
