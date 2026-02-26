const path = require('path');

module.exports = {
  apps: [
    {
      name: 'metabot',
      script: 'src/index.ts',
      interpreter: path.join(__dirname, 'node_modules/.bin/tsx'),
      cwd: __dirname,

      // Watch for code changes and auto-restart
      watch: ['src', 'bots.json'],
      watch_delay: 1000,
      ignore_watch: ['node_modules', 'dist', '*.log', 'nohup.out'],

      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,

      // Logs
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
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
