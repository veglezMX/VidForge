// Isolated PostgreSQL + fake gateways + real FFmpeg. No provider credentials or charges.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('apps/backend');
const require = createRequire(path.join(root, 'package.json'));
const task = randomUUID();
const scratch = path.join(root, '.processing', `integration-${task}`);
await fs.mkdir(scratch, { recursive: true });
function run(bin, args, env = process.env) {
  const r = spawnSync(bin, args, { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let container, redisContainer, app, db;
const calls = [];
const jobs = new Map();
let gatewayBase;
let mode = 'normal';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
);
const video = path.join(scratch, 'fixture.mp4'),
  voice = path.join(scratch, 'fixture.mp3');
run('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=160x160:r=16',
  '-t',
  '1',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  video,
]);
run('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=1',
  '-c:a',
  'libmp3lame',
  voice,
]);
const gateway = createServer(async (req, res) => {
  try {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const bytes = Buffer.concat(buffers);
    const body = req.headers['content-type']?.includes('json')
      ? JSON.parse(bytes.toString() || '{}')
      : {};
    calls.push({ path: req.url, body, authorization: req.headers.authorization });
    const json = (value) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (req.url === '/asset/redirect') {
      res.writeHead(302, { Location: 'http://169.254.169.254/' });
      return res.end();
    }
    if (req.url.startsWith('/asset/')) {
      assert.equal(req.headers.authorization, undefined, 'credentials leaked to asset download');
      return res.end(req.url.endsWith('image') ? png : await fs.readFile(video));
    }
    assert.equal(req.headers.authorization, 'Bearer synthetic-key');
    if (req.url === '/v1/assets') return json({ asset_id: randomUUID() });
    if (req.url === '/v1/models/capabilities')
      return json({
        models: [{ alias: 'video-main', known: true, frame_range: [81, 100], default_fps: 16 }],
      });
    if (req.url === '/v1/media/validate') return json({ valid: true });
    if (req.url === '/v1/media/generations') {
      if (mode === 'ambiguous') {
        req.socket.destroy();
        return;
      }
      const id = randomUUID();
      jobs.set(id, body.modality);
      return json({ job_id: id, status: 'queued' });
    }
    if (req.url.startsWith('/v1/jobs/')) {
      const id = req.url.split('/')[3],
        kind = jobs.get(id);
      return json({
        job_id: id,
        status: mode === 'waiting' ? 'running' : 'succeeded',
        assets: [
          {
            asset_id: randomUUID(),
            url: `${gatewayBase}/asset/${kind}`,
            content_type: kind === 'image' ? 'image/png' : 'video/mp4',
          },
        ],
      });
    }
    if (req.url === '/v1/audio/speech') {
      res.setHeader('Content-Type', 'audio/mpeg');
      return res.end(await fs.readFile(voice));
    }
    if (req.url === '/v1/chat/completions') {
      const vision = body.messages.some((m) => Array.isArray(m.content));
      const output = vision
        ? {
            caption: 'Synthetic square',
            product: { name: 'Square' },
            scene: { scene: 'studio' },
            clip: { objects: ['square'] },
          }
        : {
            title: 'Synthetic',
            shots: Array.from({ length: 3 }, () => ({
              duration: 6,
              description: 'Blue square',
              voiceover: 'Synthetic narration',
              caption: 'Test',
            })),
          };
      return json({ choices: [{ message: { content: JSON.stringify(output) } }] });
    }
    res.statusCode = 404;
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
gatewayBase = `http://127.0.0.1:${gateway.address().port}`;
try {
  const password = randomBytes(24).toString('hex');
  container = run(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--label',
      'vidforge-test=' + task,
      '-e',
      'POSTGRES_PASSWORD',
      '-p',
      '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ],
    { ...process.env, POSTGRES_PASSWORD: password }
  );
  redisContainer = run(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--label',
      'vidforge-test=' + task,
      '-e',
      'REDIS_PASSWORD',
      '-p',
      '127.0.0.1::6379',
      'redis:7-alpine',
      'sh',
      '-c',
      'exec redis-server --requirepass "$REDIS_PASSWORD"',
    ],
    { ...process.env, REDIS_PASSWORD: password }
  );
  const redisPort = JSON.parse(run('docker', ['inspect', redisContainer]))[0].NetworkSettings.Ports[
    '6379/tcp'
  ][0].HostPort;
  const port = JSON.parse(run('docker', ['inspect', container]))[0].NetworkSettings.Ports[
    '5432/tcp'
  ][0].HostPort;
  for (let i = 0; i < 60; i++) {
    if (
      spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' })
        .status === 0
    )
      break;
    await sleep(500);
  }
  Object.assign(process.env, {
    NODE_ENV: 'test',
    JWT_SECRET: randomBytes(32).toString('hex'),
    DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
    DB_TLS: 'false',
    DB_SYNCHRONIZE: 'false',
    REDIS_URL: `redis://:${password}@127.0.0.1:${redisPort}`,
    PROCESS_ROLE: 'media-worker',
    QUEUE_INLINE_FALLBACK: 'false',
    AGENT_CHECKPOINTER: 'memory',
    SEED_DEMO_USER: 'false',
    STORAGE_ROOT: path.join(scratch, 'storage'),
    PROCESSING_ROOT: path.join(scratch, 'work'),
    LLM_GATEWAY_URL: gatewayBase,
    MEDIA_GATEWAY_URL: gatewayBase,
    LLM_GATEWAY_KEY: 'synthetic-key',
    MEDIA_GATEWAY_KEY: 'synthetic-key',
    SPEECH_VOICE: 'Rachel',
    ASSET_STORE_ORIGINS: gatewayBase,
    VIDFORGE_PROFILE: 'personal',
  });
  const { DataSource } = require('typeorm');
  db = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: [root + '/dist/**/*.entity.js'],
    migrations: [root + '/dist/database/migrations/[0-9]*.js'],
    synchronize: false,
  });
  await db.initialize();
  await db.runMigrations();
  console.log('Migrations passed');
  await db.destroy();
  db = undefined;
  const { NestFactory } = require('@nestjs/core'),
    { ValidationPipe } = require('@nestjs/common');
  const { AppModule } = require(root + '/dist/app.module.js');
  app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
  );
  await app.listen(0, '127.0.0.1');
  console.log('Application started');
  const base = await app.getUrl();
  async function api(
    route,
    body,
    token,
    method = body === undefined ? 'GET' : 'POST',
    status = 200
  ) {
    const response = await fetch(base + '/api' + route, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    assert.ok(
      response.status === status || (status === 200 && response.status === 201),
      `${route}: ${response.status} ${JSON.stringify(data)}`
    );
    return data;
  }
  const user = await api('/auth/register', {
    email: 'alice@example.test',
    username: 'Alice',
    password: 'synthetic-password',
  });
  const other = await api('/auth/register', {
    email: 'bob@example.test',
    username: 'Bob',
    password: 'synthetic-password',
  });
  const token = user.token;
  const space = await api('/spaces', { name: 'Synthetic project' }, token);
  assert.equal(space.cloudProcessingEnabled, false);
  const dto = {
    title: 'Synthetic',
    productSpaceId: space.id,
    burnSubtitle: false,
    quality: '480p',
    storyboard: [{ description: 'A blue square', duration: 6, voiceover: 'Synthetic narration' }],
  };
  await api('/creation/task', dto, token, 'POST', 403);
  assert.equal(calls.length, 0);
  const form = new FormData();
  form.set('productSpaceId', space.id);
  form.set('file', new Blob([png], { type: 'image/png' }), 'image.png');
  const upload = await fetch(base + '/api/material/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const material = await upload.json();
  assert.equal(upload.status, 201, JSON.stringify(material));
  assert.equal(calls.length, 0);
  assert.equal((await fetch(base + material.url)).status, 401);
  assert.equal(
    (await fetch(base + material.url, { headers: { Authorization: `Bearer ${other.token}` } }))
      .status,
    404
  );
  await api('/spaces/' + space.id, { cloudProcessingEnabled: true }, token, 'PATCH');
  await api('/material/' + material.id + '/analyze', {}, token, 'PATCH');
  const visionCall = calls.find((c) => c.path === '/v1/chat/completions');
  assert.ok(
    visionCall.body.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((c) => c.image_url?.url.startsWith('data:image/'))
    )
  );
  assert.equal(visionCall.body.model, 'openai-main');
  await api(
    '/script/generate',
    {
      productName: 'Square',
      category: 'Test',
      sellingPoints: 'Blue',
      productSpaceId: space.id,
      duration: 18,
    },
    token
  );

  let lastTask;
  async function workflow(materialId) {
    const before = calls.length;
    const task = await api(
      '/creation/task',
      { ...dto, storyboard: [{ ...dto.storyboard[0], ...(materialId ? { materialId } : {}) }] },
      token
    );
    let result;
    for (let i = 0; i < 120; i++) {
      result = await api('/creation/task/' + task.id, undefined, token);
      if (result.status === 'completed') break;
      if (result.errorMessage) throw new Error(result.errorMessage);
      await sleep(250);
    }
    assert.equal(result.status, 'completed', JSON.stringify(result));
    lastTask = task;
    const generated = calls
      .slice(before)
      .filter((c) => c.path === '/v1/media/generations')
      .map((c) => c.body.modality);
    assert.deepEqual(generated, materialId ? ['video'] : ['image', 'video']);
    assert.ok(calls.slice(before).some((c) => c.path === '/v1/audio/speech'));
    const output = await fetch(base + result.result.url, {
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-31' },
    });
    assert.equal(output.status, 206);
    assert.equal((await output.arrayBuffer()).byteLength, 32);
    assert.ok(!JSON.stringify(result).includes('synthetic-key'));
    const { GatewayVideoService } = require(
      root + '/dist/modules/ai/services/gateway-video.service.js'
    );
    const stageCalls = calls.length;
    const shot = result.storyboard[0];
    assert.equal(
      await app.get(GatewayVideoService).generateVideo({
        context: { userId: user.user.id, productSpaceId: space.id, runId: task.id },
        operationKey: `${task.id}:${shot.id}:0`,
        prompt: shot.description,
        duration: shot.duration,
        materialId,
      }),
      shot.videoUrl
    );
    assert.equal(calls.length, stageCalls, 'successful stage was purchased again');
    const exported = await api(
      '/export',
      { creationTaskId: task.id, format: 'mp4', resolution: '480p' },
      token
    );
    let exportResult;
    for (let i = 0; i < 120; i++) {
      exportResult = await api('/export/' + exported.id, undefined, token);
      if (['completed', 'failed'].includes(exportResult.status)) break;
      await sleep(250);
    }
    assert.equal(exportResult.status, 'completed', JSON.stringify(exportResult));
    assert.equal(
      (
        await fetch(base + exportResult.outputUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      200
    );
  }
  await workflow(material.id);
  await workflow();
  await api('/creation/task/' + lastTask.id + '/cancel', {}, token);
  assert.equal((await api('/creation/task/' + lastTask.id, undefined, token)).status, 'completed');

  const { GatewayVideoService } = require(
    root + '/dist/modules/ai/services/gateway-video.service.js'
  );
  const { GatewayOperation } = require(
    root + '/dist/modules/ai/entities/gateway-operation.entity.js'
  );
  const gatewayService = app.get(GatewayVideoService);
  const context = { userId: user.user.id, productSpaceId: space.id, runId: lastTask.id };
  const ambiguous = {
    context,
    operationKey: 'ambiguous',
    prompt: 'Synthetic',
    duration: 6,
    materialId: material.id,
  };
  mode = 'ambiguous';
  await assert.rejects(gatewayService.generateVideo(ambiguous), /unknown/);
  const purchases = calls.filter((c) => c.path === '/v1/media/generations').length;
  await assert.rejects(gatewayService.generateVideo(ambiguous), /reconciliation/);
  assert.equal(calls.filter((c) => c.path === '/v1/media/generations').length, purchases);
  const repo = app.get(DataSource).getRepository(GatewayOperation);
  assert.equal(
    (await repo.findOneByOrFail({ operationKey: 'ambiguous:video' })).status,
    'reconciliation'
  );
  mode = 'waiting';
  const pending = gatewayService.generateVideo({ ...ambiguous, operationKey: 'cancelled' });
  const rejected = assert.rejects(pending, /cancelled/);
  for (let i = 0; i < 40; i++) {
    if ((await repo.findOneBy({ operationKey: 'cancelled:video' }))?.remoteJobId) break;
    await sleep(50);
  }
  await gatewayService.cancelRun(lastTask.id, user.user.id);
  mode = 'normal';
  await rejected;
  assert.equal((await repo.findOneByOrFail({ operationKey: 'cancelled:video' })).localUrl, null);
  await assert.rejects(
    gatewayService.download('http://169.254.169.254/secret', path.join(scratch, 'forbidden')),
    /Untrusted/
  );
  await assert.rejects(
    gatewayService.download(gatewayBase + '/asset/redirect', path.join(scratch, 'redirect'))
  );
  const clientRequire = createRequire(path.resolve('apps/frontend/package.json'));
  const { io } = clientRequire('socket.io-client');
  async function rejectedSocket(auth, taskId) {
    const socket = io(base + '/creation', { auth, transports: ['websocket'], reconnection: false });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Unauthorized socket remained connected')),
          3000
        );
        socket.on('connect', () => {
          if (taskId) socket.emit('subscribe', taskId);
        });
        socket.on('disconnect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.on('connect_error', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      socket.close();
    }
  }
  await rejectedSocket({});
  await rejectedSocket({ token: other.token }, lastTask.id);

  const { Material } = require(root + '/dist/modules/material/entities/material.entity.js');
  const legacyPath = path.join(process.env.STORAGE_ROOT, 'uploads', 'legacy.png');
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, png);
  await app
    .get(DataSource)
    .getRepository(Material)
    .update(material.id, { url: '/static/uploads/legacy.png' });
  run(process.execPath, ['scripts/import-legacy-local-assets.mjs', '--apply']);
  const migrated = await api('/material/' + material.id, undefined, token);
  assert.match(migrated.url, /^\/api\/assets\//);
  assert.equal((await fs.stat(legacyPath)).size, png.length);
  await api('/spaces/' + space.id, { cloudProcessingEnabled: false }, token, 'PATCH');
  const count = calls.length;
  await api('/creation/task', dto, token, 'POST', 403);
  assert.equal(calls.length, count);
  await api(
    '/auth/password',
    { oldPassword: 'synthetic-password', newPassword: 'changed-password' },
    token,
    'PATCH'
  );
  await api('/auth/me', undefined, token, 'GET', 401);
  console.log(
    'PASS: isolated migrations/startup, consent, local upload, cross-owner assets, both video+narration+FFmpeg workflows, range requests, session revocation; provider spend $0'
  );
} finally {
  if (app) await app.close();
  if (db?.isInitialized) await db.destroy();
  await new Promise((r) => gateway.close(r));
  if (redisContainer) run('docker', ['rm', '-f', redisContainer]);
  if (container) run('docker', ['rm', '-f', container]);
  await fs.rm(scratch, { recursive: true, force: true });
}
