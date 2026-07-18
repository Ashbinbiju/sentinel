module.exports = {
  apps: [
    {
      name: "sentinel-api",
      script: "pnpm",
      args: "--filter @workspace/api-server start",
      kill_timeout: 7000,
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "auto-trader",
      script: "pnpm",
      args: "--filter @workspace/auto-trader start",
      kill_timeout: 7000,
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
