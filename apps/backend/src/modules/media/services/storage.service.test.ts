import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StorageService, contained, assetId } from './storage.service';

test('owned assets preserve bytes and reject cross-owner access, traversal and symlink escape', async () => {
  const rows = new Map<string, any>();
  const repo = {
    create: (row: any) => ({ ...row, id: randomUUID() }),
    save: async (row: any) => {
      rows.set(row.id, row);
      return row;
    },
    findOneBy: async ({ id, userId }: any) =>
      rows.get(id)?.userId === userId ? rows.get(id) : null,
    delete: async ({ id }: any) => rows.delete(id),
  };
  const storage = new StorageService({ getRepository: () => repo } as any);
  await storage.onModuleInit();
  const task = randomUUID();
  const work = await storage.createTaskWorkdir('test', task);
  const source = path.join(work, 'fixture.mp4');
  const payload = Buffer.from('synthetic asset bytes');
  await fs.writeFile(source, payload);
  let output: any;
  try {
    output = await storage.publish(source, 'test', 'fixture.mp4', 'alice');
    assert.equal(output.size, payload.length);
    assert.equal(output.sha256, createHash('sha256').update(payload).digest('hex'));
    assert.deepEqual(await fs.readFile((await storage.owned(output.url, 'alice')).path), payload);
    await assert.rejects(storage.owned(output.url, 'bob'), /Asset unavailable/);
    await assert.rejects(storage.delete(output.url, 'bob'), /Asset unavailable/);
    assert.throws(() => assetId('file:///etc/passwd'), /owned local asset/);
    assert.throws(() => contained(storage.getStorageRoot(), '../secret'), /Invalid asset path/);
    await fs.unlink(output.absPath);
    await fs.symlink(source, output.absPath);
    await assert.rejects(storage.owned(output.url, 'alice'), /Asset unavailable/);
  } finally {
    if (output) await fs.unlink(output.absPath).catch(() => {});
    await storage.cleanupTaskWorkdir('test', task);
  }
});
