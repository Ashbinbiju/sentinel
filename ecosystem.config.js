module.exports = {
  apps: [
    {
      name: "sentinel-api",
      script: "pnpm",
      args: "run start --filter @workspace/api-server",
      kill_timeout: 7000,
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "auto-trader",
      script: "pnpm",
      args: "run start --filter @workspace/auto-trader",
      kill_timeout: 7000,
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
