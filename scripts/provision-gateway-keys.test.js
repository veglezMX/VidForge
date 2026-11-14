import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
const execute = promisify(execFile);
test('provisioning scopes keys, persists once, and never prints secrets', async () => {
  await mkdir('.processing', { recursive: true });
  const work = await mkdtemp('.processing/key-test-');
  const requests = [];
  const server = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/openapi.json')
      return res.end(
        JSON.stringify({
          components: { schemas: { KeyGenerateBody: { properties: { allowed_models: {} } } } },
        })
      );
    assert.equal(req.url, '/key/generate');
    requests.push(JSON.parse(Buffer.concat(buffers).toString()));
    res.end(JSON.stringify({ key: 'sk-synthetic-' + requests.length }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = path.join(work, 'backend.env'),
      media = path.join(work, 'media.env'),
      llm = path.join(work, 'llm.env');
    await writeFile(
      env,
      `LLM_GATEWAY_URL=${url}\nMEDIA_GATEWAY_URL=${url}\nJWT_SECRET=preserved\nLLM_GATEWAY_KEY=\nMEDIA_GATEWAY_KEY=\n`
    );
    await writeFile(media, 'MEDIA_MASTER_KEY=media-master-secret\n');
    await writeFile(llm, 'LITELLM_MASTER_KEY=llm-master-secret\n');
    const args = [
      'scripts/provision-gateway-keys.mjs',
      '--env',
      env,
      '--media-admin-env',
      media,
      '--llm-admin-env',
      llm,
      '--media-budget-usd',
      '1',
      '--llm-budget-usd',
      '1',
    ];
    const result = await execute(process.execPath, args);
    assert.ok(!/sk-synthetic|master-secret/.test(result.stdout + result.stderr));
    assert.deepEqual(requests[0].allowed_models, ['image-main', 'video-main', 'voice-main']);
    assert.equal(requests[0].budget_usd, 1);
    assert.deepEqual(requests[1].models, ['openai-main']);
    assert.equal(requests[1].max_budget, 1);
    const saved = await readFile(env, 'utf8');
    assert.match(saved, /JWT_SECRET=preserved/);
    assert.ok(!saved.includes('master-secret'));
    assert.equal((await stat(env)).mode & 0o777, 0o600);
    await execute(process.execPath, args);
    assert.equal(requests.length, 2);
    assert.equal(await readFile(env, 'utf8'), saved);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(work, { recursive: true, force: true });
  }
});
