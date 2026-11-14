import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
if (existsSync('.env') || existsSync('apps/backend/.env'))
  throw new Error('Existing environment files preserved; configure missing settings manually');
const db = randomBytes(32).toString('hex'),
  redis = randomBytes(32).toString('hex'),
  jwt = randomBytes(48).toString('hex');
writeFileSync('.env', `DB_PASSWORD=${db}\nREDIS_PASSWORD=${redis}\n`, { mode: 0o600, flag: 'wx' });
writeFileSync(
  'apps/backend/.env',
  `NODE_ENV=production\nVIDFORGE_PROFILE=personal\nJWT_SECRET=${jwt}\nDATABASE_URL=postgresql://vidforge:${db}@127.0.0.1:55432/vidforge\nREDIS_URL=redis://:${redis}@127.0.0.1:56379\nDB_TLS=false\nDB_SYNCHRONIZE=false\nWEB_BASE_URL=http://localhost:3000\nQUEUE_INLINE_FALLBACK=false\nLLM_GATEWAY_URL=http://127.0.0.1:4000\nMEDIA_GATEWAY_URL=http://127.0.0.1:8080\nLLM_GATEWAY_KEY=\nMEDIA_GATEWAY_KEY=\nSPEECH_VOICE=\nASSET_STORE_ORIGINS=\n`,
  { mode: 0o600, flag: 'wx' }
);
console.log(
  'Created owner-readable local secrets. Configure scoped gateway keys and a supported voice in apps/backend/.env.'
);
