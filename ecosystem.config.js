module.exports = {
  apps: [
    {
      name: 'tldreply-bot',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      // Ensure logs are handled by PM2 if needed, though we have internal logging now
      output: './logs/pm2-out.log',
      error: './logs/pm2-error.log',
      time: true,
    },
  ],
};
