module.exports = {
  apps: [
    {
      name: "sentinel-api",
      script: "pnpm",
      args: "--filter @workspace/api-server start",
      kill_timeout: 7000,
      autorestart: true,
      max_memory_restart: "450M",
      time: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "auto-trader",
      script: "pnpm",
      args: "--filter @workspace/auto-trader start",
      kill_timeout: 7000,
      cron_restart: "15 3 * * *", // 03:15 UTC = 08:45 AM IST (Daily pre-market fresh start)
      autorestart: true,
      max_memory_restart: "450M",
      time: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
