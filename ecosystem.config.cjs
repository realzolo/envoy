/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");

const appRoot = path.resolve(process.env.ENVOY_APP_ROOT || __dirname);
const host = process.env.ENVOY_HOST || "127.0.0.1";
const port = String(process.env.PORT || 6178);

const common = {
  cwd: appRoot,
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  restart_delay: 3000,
  max_restarts: 10,
  min_uptime: "10s",
  kill_timeout: 30000,
  time: true,
  env: {
    NODE_ENV: "production",
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: "envoy-web",
      script: path.join(appRoot, "node_modules/next/dist/bin/next"),
      args: ["start", "--hostname", host, "--port", port],
      interpreter: process.execPath,
      max_memory_restart: "1G",
      env: {
        ...common.env,
        HOSTNAME: host,
        PORT: port,
      },
    },
    {
      ...common,
      name: "envoy-worker",
      script: path.join(appRoot, "node_modules/tsx/dist/cli.mjs"),
      args: ["src/worker/index.ts"],
      interpreter: process.execPath,
      max_memory_restart: "1G",
    },
  ],
};
