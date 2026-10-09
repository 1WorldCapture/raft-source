// Node host for the unmodified original CLI source.
//
// The original daemon wrapper (packages/daemon/src/drivers/cliTransport.ts)
// execs `node <slockCliPath>`. packages/cli has no committed dist, and node
// cannot load packages/cli/src/index.ts by itself. This file is not a CLI
// implementation and does not interpret commands: it re-execs that source
// through the repository tsx loader, forwarding argv, env, cwd, and stdio
// (so `raft message send` still reads the real stdin pipe).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');
const entry = path.join(repo, 'packages/cli/src/index.ts');
const loader = path.join(repo, 'node_modules/tsx/dist/esm/index.mjs');

const child = spawn(process.execPath, ['--import', loader, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd(),
});

function forward(signal) {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

child.once('error', (error) => {
  console.error(`m5 original CLI host could not start packages/cli/src/index.ts (${error.message})`);
  process.exit(127);
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
