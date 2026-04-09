const path = require('path');

module.exports = {
  apps: [
    {
      name: 'metabot',
      script: 'src/index.ts',
      interpreter: path.join(__dirname, 'node_modules/.bin/tsx'),
      cwd: __dirname,

      // Watch disabled — use `metabot restart` to apply code changes manually
      watch: false,

      // Graceful shutdown — give destroy() enough time to send restart cards
      kill_timeout: 8000,

      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,

      // Logs
      error_file: path.join(__dirname, 'logs', 'error.log'),
      out_file: path.join(__dirname, 'logs', 'out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Environment
      env: {
        NODE_ENV: 'production',
        CLAUDE_MAX_TURNS: '',  // unlimited turns (override any inherited shell env)
      },
    },
  ],
};
