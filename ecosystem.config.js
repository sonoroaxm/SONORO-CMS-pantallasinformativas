/**
 * ============================================
 * SONORO AV - ECOSYSTEM.CONFIG.JS
 * ============================================
 */

module.exports = {
  apps: [
    {
      name: 'sonoro-backend',
      script: './backend/src/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV:        'development',
        PORT:            5000,
        HOST:            '0.0.0.0',
        DB_USER:         'postgres',
        DB_HOST:         'localhost',
        DB_PORT:         5432,
        DB_NAME:         'cms_signage',
        DB_PASSWORD:     'postgres123',
        REDIS_HOST:      'localhost',
        REDIS_PORT:      6379,
        LOG_LEVEL:       'debug'
      },
      out_file:            './logs/sonoro-backend-out.log',
      error_file:          './logs/sonoro-backend-error.log',
      log_date_format:     'YYYY-MM-DD HH:mm:ss Z',
      watch:               ['backend/src'],
      watch_delay:         500,
      ignore_watch:        ['node_modules', 'logs', 'uploads'],
      max_restarts:        10,
      min_uptime:          '10s',
      max_memory_restart:  '500M',
      kill_timeout:        5000,
      windowsHide:         true,
      hide:                true
    }
  ]
};
