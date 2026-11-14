// Local task runner. Dotenv is parsed as data, never sourced as shell code.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const backend = path.join(root, 'apps/backend');
const task = process.argv[2];
const commands = {
  frontend: [
    'pnpm',
    ['--filter', '@vidforge/frontend', 'dev', '--host', '127.0.0.1', '--strictPort'],
    root,
  ],
  api: [process.execPath, ['dist/main.js'], backend],
  'media-worker': [process.execPath, ['dist/worker-main.js'], backend],
  'agent-worker': [process.execPath, ['dist/worker-main.js'], backend],
  migrate: ['pnpm', ['migration:run'], backend],
  checkpointer: [process.execPath, ['scripts/setup-agent-checkpointer.mjs'], root],
};
function check(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'ignore' });
  if (result.error || result.status !== 0)
    throw new Error(`Required tool unavailable: ${command} ${args.join(' ')}`);
}
function environment() {
  const envPath = path.join(backend, '.env');
  if (!existsSync(envPath)) throw new Error('Run just setup first; apps/backend/.env is missing');
  return { ...process.env, ...parseEnv(readFileSync(envPath, 'utf8')) };
}
async function supervise(names) {
  const env = names.some((name) => name !== 'frontend') ? environment() : process.env;
  if (
    names.some((name) => ['api', 'media-worker', 'agent-worker'].includes(name)) &&
    !existsSync(path.join(backend, 'dist/main.js'))
  )
    throw new Error('Run just build before starting the application');
  const children = new Set();
  let stopping = false;
  let timer;
  const signalChild = (child, signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) signalChild(child, 'SIGTERM');
    timer = setTimeout(() => {
      for (const child of children) signalChild(child, 'SIGKILL');
    }, 10000);
    timer.unref();
  };
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
  await Promise.all(
    names.map(
      (name) =>
        new Promise((resolve) => {
          const [command, args, cwd] = commands[name];
          const role = name === 'api' ? 'api' : name.endsWith('-worker') ? name : undefined;
          const child = spawn(command, args, {
            cwd,
            env: { ...env, ...(role ? { PROCESS_ROLE: role } : {}) },
            stdio: 'inherit',
            detached: true,
          });
          children.add(child);
          child.once('error', (error) => {
            console.error(`${name}: ${error.message}`);
            stop(1);
          });
          child.once('close', (code, signal) => {
            children.delete(child);
            if (!stopping) {
              // A server exiting, even successfully, stops the other processes.
              if (names.length > 1)
                console.error(`${name} stopped (${signal || code}); stopping the application`);
              stop(code ?? 1);
            }
            resolve();
          });
        })
    )
  );
  clearTimeout(timer);
}
try {
  if (task === 'doctor') {
    if (Number(process.versions.node.split('.')[0]) < 24)
      throw new Error('Node 24 or later is required');
    for (const [command, args] of [
      ['pnpm', ['--version']],
      ['docker', ['compose', 'version']],
      ['ffmpeg', ['-version']],
      ['ffprobe', ['-version']],
    ])
      check(command, args);
    console.log('Required tools are available. Docker must be running for just setup.');
  } else if (task === 'init') {
    const files = ['.env', 'apps/backend/.env'].map((file) => existsSync(path.join(root, file)));
    if (files.every(Boolean)) console.log('Existing local environments preserved.');
    else if (files.some(Boolean))
      throw new Error(
        'Only one environment file exists; preserve it and configure the missing file manually'
      );
    else {
      const result = spawnSync(process.execPath, ['scripts/setup-local-secrets.mjs'], {
        cwd: root,
        stdio: 'inherit',
      });
      process.exitCode = result.status ?? 1;
    }
  } else if (task === 'run') await supervise(['api', 'media-worker', 'agent-worker', 'frontend']);
  else if (commands[task]) await supervise([task]);
  else throw new Error(`Unknown local task: ${task}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
