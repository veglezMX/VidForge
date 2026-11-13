// Administrative provisioning only; does not submit generation requests.
// Master/provider secrets never enter the backend environment or stdout.
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, [])
);
const envPath = path.resolve(args.env || 'apps/backend/.env');
if ((await lstat(envPath)).isSymbolicLink())
  throw new Error('Environment symlinks are not supported');
let contents = await readFile(envPath, 'utf8');
const env = parseEnv(contents);
const alias = 'vidforge-' + randomUUID();
function origin(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw new Error('Invalid gateway URL');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Remote gateways require HTTPS');
  return url.origin;
}
async function request(base, route, key, body) {
  const response = await fetch(base + route, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(`Gateway provisioning failed (${response.status}); no automatic retry`);
  return response.json();
}
for (const kind of ['media', 'llm']) {
  const variable = kind.toUpperCase() + '_GATEWAY_KEY';
  if (env[variable]) {
    console.log(`${kind}: existing credential preserved`);
    continue;
  }
  const budget = Number(args[kind + '-budget-usd']);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 100)
    throw new Error(`Set an explicit ${kind} budget between 0 and 100 USD`);
  const adminPath = args[kind + '-admin-env'];
  if (!adminPath) throw new Error(`Provide --${kind}-admin-env`);
  const adminEnv = parseEnv(await readFile(adminPath, 'utf8'));
  const master = adminEnv[kind === 'llm' ? 'LITELLM_MASTER_KEY' : 'MEDIA_MASTER_KEY'];
  if (!master) throw new Error(`Missing ${kind} administrative key`);
  const base = origin(env[kind.toUpperCase() + '_GATEWAY_URL']);
  const models =
    kind === 'llm'
      ? [
          ...new Set([
            env.TEXT_MODEL_ALIAS || 'openai-main',
            env.VISION_MODEL_ALIAS || 'openai-main',
          ]),
        ]
      : [
          env.IMAGE_MODEL_ALIAS || 'image-main',
          env.VIDEO_MODEL_ALIAS || 'video-main',
          env.VOICE_MODEL_ALIAS || 'voice-main',
        ];
  if (kind === 'media') {
    const schema = await request(base, '/openapi.json', master);
    if (!schema.components?.schemas?.KeyGenerateBody?.properties?.allowed_models)
      throw new Error('Deploy reviewed media-gateway model restrictions before provisioning');
  }
  const body =
    kind === 'llm'
      ? { key_alias: alias, models, max_budget: budget, rpm_limit: 20 }
      : { alias, budget_usd: budget, rpm_limit: 20, allowed_models: models };
  const result = await request(base, '/key/generate', master, body);
  if (typeof result.key !== 'string' || !result.key.startsWith('sk-') || /[\r\n]/.test(result.key))
    throw new Error('Invalid generated credential');
  // Save immediately, so a later service failure cannot lose the one-time secret.
  const line = `${variable}=${result.key}`;
  const expression = new RegExp(`^${variable}=.*$`, 'm');
  contents = expression.test(contents)
    ? contents.replace(expression, line)
    : contents + '\n' + line + '\n';
  const temporary = envPath + '.' + randomUUID();
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  await rename(temporary, envPath);
  console.log(
    `${kind}: dedicated key saved; aliases=${models.join(',')}; budget=${budget} USD; no generation submitted`
  );
}
