/**
 * MetaBot 多进程 PM2 配置
 *
 * 架构：每个 bot 独立一个 Node.js 进程，互不共享状态。
 * - 通过 BOT_NAME 环境变量让 src/config.ts 把 bots.json 过滤成单 bot
 * - 每个 bot 有独立的 API/Memory 端口、独立的 ~/.metabot/<name>/ 数据目录
 * - 重启某个 bot：`pm2 restart <bot-name>`
 *
 * Bot 列表从 bots.json 自动读取，端口按顺序自动分配：
 *   第 1 个 bot  API <BASE>,     Memory <BASE+10>
 *   第 2 个 bot  API <BASE+1>,   Memory <BASE+11>
 *   ...
 *
 * 端口基准可通过 .env 中 API_PORT_BASE 配置（默认 10001）。
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT     = __dirname;
const HOME     = os.homedir();
const LOGS_DIR = path.join(ROOT, 'logs');

// ── 从 bots.json 读取 bot 列表 ──────────────────────────────────────────────
const BOTS_CONFIG_PATH = path.join(ROOT, 'bots.json');
let bots = [];
try {
  const data = JSON.parse(fs.readFileSync(BOTS_CONFIG_PATH, 'utf-8'));
  bots = (data.feishuBots || []);
} catch (err) {
  console.error(`[ecosystem] Failed to read ${BOTS_CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

// ── 解析 .env ───────────────────────────────────────────────────────────────
// PM2 daemon 抓的 env 是它启动那一刻的快照,后续改 .env 不会反映给已 spawn 的子进程,
// 而 dotenv 在 bot 进程里默认不会覆盖已有的 process.env。这两条叠起来,会让没有
// per-bot `env` 块的 bot 长期沿用一份过期的 ANTHROPIC_* / METABOT_* 凭据。
// 这里手工把 .env 解析一遍,然后在 makeApp() 里 inject 进每个 app 的 env block —
// PM2 启动子进程时把 .env 的最新值显式写进去,顶掉 daemon-level 的缓存。
// 这些 key 是 PM2 ecosystem **按 bot index 独立计算**的,不能让 .env 覆盖,
// 否则所有 bot 都拿到同一份固定值 → 端口冲突 / 共享 db / BOTS_CONFIG 错位等灾难。
const DOTENV_DENYLIST = new Set([
  'API_PORT', 'MEMORY_PORT', 'META_MEMORY_URL',
  'BOTS_CONFIG', 'BOT_NAME', 'API_PORT_BASE',
  'METABOT_DATA_DIR', 'MEMORY_DATABASE_DIR',
  'CLAUDE_DEFAULT_WORKING_DIRECTORY',
]);

const dotenvVars = {};
let apiPortBase = 10001;
try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val   = m[2];
    // strip optional matching quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // 单独处理 API_PORT_BASE(本文件自己用),其它进 dotenvVars(但排除冲突 key)
    if (key === 'API_PORT_BASE') {
      apiPortBase = parseInt(val, 10);
    } else if (!DOTENV_DENYLIST.has(key)) {
      dotenvVars[key] = val;
    }
  }
} catch { /* .env 不存在也没关系 */ }

// ── 生成 PM2 app 配置 ───────────────────────────────────────────────────────
function makeApp(bot, index) {
  const { name } = bot;
  const apiPort    = apiPortBase + index * 3;
  const memoryPort = apiPortBase + index * 3 + 1;
  const dataRoot   = path.join(HOME, '.metabot', name);

  // Per-bot env injection (`env: { ... }` in bots.json) — same pattern as
  // Codex's `codex.env`. Lets a bot use a third-party Anthropic-compatible
  // proxy by setting ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY.
  // Auto-injects METABOT_PREFER_ENV_AUTH=true when an Anthropic auth env is
  // present, so the executor bypasses its default filter that strips these
  // vars when ~/.claude/.credentials.json exists. User does not have to set
  // the flag manually.
  const customEnv = bot.env || {};
  const hasAnthropicAuth = !!(customEnv.ANTHROPIC_AUTH_TOKEN || customEnv.ANTHROPIC_API_KEY);
  const autoFlags = hasAnthropicAuth ? { METABOT_PREFER_ENV_AUTH: 'true' } : {};

  return {
    name,
    script:           'src/index.ts',
    // Use `node --import tsx` (tsx 4.x cross-platform entrypoint) instead of
    // the tsx wrapper script — wrapper is a POSIX shell script with no .cmd
    // shim, which PM2 can't spawn on Windows. Backport from upstream PR #245.
    interpreter:      'node',
    interpreter_args: '--import tsx',
    cwd:              ROOT,

    watch: false,

    autorestart:   true,
    max_restarts:  10,
    min_uptime:    '10s',
    restart_delay: 3000,

    error_file: path.join(LOGS_DIR, `${name}-error.log`),
    out_file:   path.join(LOGS_DIR, `${name}-out.log`),
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    env: {
      NODE_ENV:            'production',
      BOTS_CONFIG:         'bots.json',
      BOT_NAME:            name,
      API_PORT:            String(apiPort),
      MEMORY_PORT:         String(memoryPort),
      METABOT_DATA_DIR:    dataRoot,
      MEMORY_DATABASE_DIR: path.join(dataRoot, 'data'),
      META_MEMORY_URL:     `http://localhost:${memoryPort}`,
      CLAUDE_MAX_TURNS:    '',
      CARD_SCHEMA_V2:      'true',
      // Per-bot 唯一 instanceId — shell 导出的 METABOT_INSTANCE_ID 是机器级,
      // 多个 bot 同时连 cloud relay 会触发 InstanceRegistry 的 replaced_by_new_registration
      // 互踢 (ping-pong)。这里追加 -<BOT_NAME> 后缀给每个 bot 一个独立身份。
      ...(process.env.METABOT_INSTANCE_ID
        ? { METABOT_INSTANCE_ID: `${process.env.METABOT_INSTANCE_ID}-${name}` }
        : {}),
      // .env 显式注入(铁锤一击 — 顶掉 PM2 daemon 的旧缓存)。
      // per-bot bots.json `env` 块仍可覆盖这里(spread 顺序)。
      ...dotenvVars,
      ...customEnv,
      ...autoFlags,
    },
  };
}

// ── metabot-manager (single-host admin panel) ───────────────────────────────
// Independent of any bot — controls bots via `pm2` shell-outs. NOT in
// bots.json. Strip per-bot env (BOT_NAME / API_PORT / MEMORY_PORT /
// METABOT_DATA_DIR) so a stray pm2 start with --update-env can never pollute
// it.
function makeManagerApp() {
  return {
    name:             'metabot-manager',
    script:           'src/manager/index.ts',
    interpreter:      'node',
    interpreter_args: '--import tsx',
    cwd:              ROOT,

    watch: false,

    autorestart:   true,
    max_restarts:  10,
    min_uptime:    '10s',
    restart_delay: 3000,

    error_file:      path.join(LOGS_DIR, 'metabot-manager-error.log'),
    out_file:        path.join(LOGS_DIR, 'metabot-manager-out.log'),
    merge_logs:      true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    env: {
      NODE_ENV:     'production',
      MANAGER_PORT: '11000',
      ...dotenvVars,
    },
  };
}

module.exports = {
  apps: [...bots.map((bot, i) => makeApp(bot, i)), makeManagerApp()],
};
