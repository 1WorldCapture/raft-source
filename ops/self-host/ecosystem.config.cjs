// pm2 process file for a source deployment. All machine-specific values come from
// ops/self-host/env.local (or $RAFT_OPS_ENV), so this file is committed unchanged.
//   pm2 start ops/self-host/ecosystem.config.cjs && pm2 save
const fs = require("node:fs");
const path = require("node:path");

const envFile = process.env.RAFT_OPS_ENV || path.join(__dirname, "env.local");
const cfg = {};
for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m) cfg[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const ROOT = cfg.RAFT_ROOT;
const OPS = cfg.RAFT_OPS_HOME;
const PATH_ENV = `${cfg.NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const NODE = path.join(cfg.NODE_BIN_DIR, "node");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");

// filter_env: true drops everything inherited from the shell that runs `pm2 start`
// (it may carry DATABASE_URL, JWT_SECRET, ... from an old `source .env`); each app only
// gets the env below plus its own .env file.
const BASE = { filter_env: true };
const HOME = process.env.HOME;

const apps = [
  {
    // Runs TypeScript directly via tsx, like the official container entrypoint.
    // PORT/HOST/TRUST_PROXY and secrets come from packages/server/.env (dotenv).
    ...BASE,
    name: cfg.RAFT_PM2_SERVER || "raft-server",
    cwd: path.join(ROOT, "packages/server"),
    script: NODE,
    args: `${TSX} src/server.ts`,
    interpreter: "none",
    env: { PATH: PATH_ENV, HOME },
    kill_timeout: 10000,
  },
  {
    // Public entry point: static web + reverse proxy. Rendered by render-nginx.sh.
    ...BASE,
    name: cfg.RAFT_PM2_NGINX || "raft-nginx",
    script: "/usr/sbin/nginx",
    args: `-p ${OPS}/nginx -c nginx.conf -g 'daemon off;'`,
    interpreter: "none",
  },
  {
    ...BASE,
    name: `${cfg.RAFT_PM2_NGINX || "raft-nginx"}-logrotate`,
    env: { PATH: PATH_ENV, HOME },
    script: path.join(__dirname, "nginx-logrotate.sh"),
    interpreter: "bash",
    cron_restart: "0 4 * * *",
    autorestart: false,
  },
];

if (cfg.RAFT_BACKUP_CRON) {
  apps.push({
    ...BASE,
    // Scheduled backup (backup.sh; RAFT_BACKUP_EVERY_HOURS / RAFT_BACKUP_UTC_HOUR). pm2 also runs it once when the app is (re)started.
    name: "raft-backup",
    script: path.join(__dirname, "backup.sh"),
    interpreter: "bash",
    cron_restart: cfg.RAFT_BACKUP_CRON,
    autorestart: false,
    env: { PATH: PATH_ENV, HOME },
  });
}

if (fs.existsSync(path.join(ROOT, "packages/trace-upload-worker/.env"))) {
  apps.push({
    // Optional. The worker has no dotenv import; Node loads its .env.
    ...BASE,
    name: cfg.RAFT_PM2_WORKER || "raft-trace-upload-worker",
    cwd: path.join(ROOT, "packages/trace-upload-worker"),
    script: NODE,
    args: `--env-file=.env ${TSX} src/node.ts`,
    interpreter: "none",
    env: { PATH: PATH_ENV, HOME },
  });
}

if (cfg.RAFT_DAEMON_KEY_FILE) {
  apps.push({
    ...BASE,
    name: cfg.RAFT_PM2_DAEMON || "raft-daemon",
    cwd: path.join(ROOT, "packages/daemon"),
    script: NODE,
    args: `dist/raft-daemon.js --server-url ${cfg.RAFT_DAEMON_SERVER_URL} --api-key-file ${cfg.RAFT_DAEMON_KEY_FILE}`,
    interpreter: "none",
    env: {
      PATH: `${PATH_ENV}:${HOME}/.local/bin`,
      HOME,
      SLOCK_HOME: cfg.RAFT_DAEMON_HOME,
    },
  });
}

module.exports = { apps };
