import { spawn } from 'node:child_process';

const processes = [];
let shuttingDown = false;

const startProcess = (name, command, args, env = process.env) => {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (code !== 0) {
      console.error(`[dev-cloud] ${name} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
      shutdown(code ?? 1);
    }
  });

  processes.push(child);
  return child;
};

const shutdown = (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(exitCode), 200);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

startProcess('config-api', 'node', ['server/configApiServer.mjs']);
startProcess('vite', 'npx', ['vite']);
