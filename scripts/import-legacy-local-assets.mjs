// Run from repository root after migrations. Dry-run by default; --apply copies
// validated owned local assets into private storage and updates existing records.
// Originals and historical remote URLs are preserved; no network downloads.
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import path from 'node:path';
import * as fs from 'node:fs/promises';
const backend = path.resolve('apps/backend');
const require = createRequire(path.join(backend, 'package.json'));
try {
  const values = parseEnv(await fs.readFile(path.join(backend, '.env'), 'utf8'));
  for (const [key, value] of Object.entries(values))
    if (process.env[key] === undefined) process.env[key] = value;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
process.chdir(backend);
const { DataSource } = require('typeorm');
const { databaseTls } = require(path.join(backend, 'dist/database/tls.config.js'));
const { StorageService, contained } = require(
  path.join(backend, 'dist/modules/media/services/storage.service.js')
);
const { FfmpegService } = require(
  path.join(backend, 'dist/modules/media/services/ffmpeg.service.js')
);
const apply = process.argv.includes('--apply');
const db = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: databaseTls(process.env.DATABASE_URL, process.env.DB_HOST, process.env.DB_TLS),
  entities: [backend + '/dist/**/*.entity.js'],
  synchronize: false,
});
let imported = 0,
  unavailable = 0;
const cache = new Map();
try {
  await db.initialize();
  const storage = new StorageService(db);
  await storage.onModuleInit();
  const ffmpeg = new FfmpegService();
  const root = await fs.realpath(storage.getStorageRoot());
  async function convert(value, owner) {
    if (Array.isArray(value)) return Promise.all(value.map((v) => convert(v, owner)));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await convert(v, owner)]))
      );
    if (typeof value !== 'string' || !value.startsWith('/static/')) return value;
    const key = owner + ':' + value;
    if (cache.has(key)) return cache.get(key);
    try {
      const relative = decodeURIComponent(value.slice('/static/'.length));
      const file = await fs.realpath(contained(root, relative));
      if (!file.startsWith(root + path.sep)) throw new Error('Outside storage');
      const kind = await ffmpeg.validateUpload(file);
      const url = apply
        ? (await storage.publish(file, 'legacy', `asset.${kind.ext}`, owner, kind.mime)).url
        : value;
      cache.set(key, url);
      imported++;
      return url;
    } catch {
      unavailable++;
      return value;
    }
  }
  const targets = [
    ['Material', ['url', 'thumbnailUrl']],
    ['CreationTask', ['storyboard', 'result']],
    ['ExportTask', ['outputUrl']],
    ['AgentRun', ['result']],
  ];
  for (const [entity, fields] of targets) {
    const repo = db.getRepository(entity);
    for (const record of await repo.find()) {
      if (!record.userId) continue;
      const update = {};
      for (const field of fields) update[field] = await convert(record[field], record.userId);
      if (apply && fields.some((f) => JSON.stringify(update[f]) !== JSON.stringify(record[f])))
        await repo.update(record.id, update);
    }
  }
  console.log(
    JSON.stringify({
      mode: apply ? 'applied' : 'dry-run',
      validatedLocalAssets: imported,
      unavailableLocalReferences: unavailable,
    })
  );
} finally {
  if (db.isInitialized) await db.destroy();
}
