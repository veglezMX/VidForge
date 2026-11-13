import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { LocalAsset } from '../entities/local-asset.entity';

export function contained(root: string, relative: string): string {
  const result = path.resolve(root, relative);
  if (result === root || !result.startsWith(root + path.sep)) throw new Error('Invalid asset path');
  return result;
}
export function assetId(url: string): string {
  // Only server-issued relative references; never accept an arbitrary URL/path as authority.
  const match = /^\/api\/assets\/([0-9a-f-]{36})$/.exec(url);
  if (!match) throw new Error('Use an owned local asset ID');
  return match[1];
}
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly root = path.resolve(process.env.STORAGE_ROOT || 'storage');
  private readonly tmp = path.resolve(process.env.PROCESSING_ROOT || '.processing');
  constructor(private readonly db: DataSource) {}
  async onModuleInit() {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(this.tmp, { recursive: true });
  }
  resolveUrl(url: string): string {
    return url;
  }
  getStorageRoot() {
    return this.root;
  }
  getBgmRoot() {
    return path.join(this.root, 'bgm');
  }
  async createTaskWorkdir(scope: string, taskId: string) {
    if (!/^[a-z0-9_-]+$/i.test(scope) || !/^[a-z0-9_-]+$/i.test(taskId))
      throw new Error('Invalid work directory ID');
    const dir = contained(this.tmp, `${scope}/${taskId}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
  async cleanupTaskWorkdir(scope: string, taskId: string) {
    if (!/^[a-z0-9_-]+$/i.test(scope) || !/^[a-z0-9_-]+$/i.test(taskId))
      throw new Error('Invalid work directory ID');
    await fs.rm(contained(this.tmp, `${scope}/${taskId}`), { recursive: true, force: true });
  }
  async owned(url: string, userId: string) {
    if (!userId) throw new NotFoundException('Asset unavailable');
    const row = await this.db.getRepository(LocalAsset).findOneBy({ id: assetId(url), userId });
    if (!row) throw new NotFoundException('Asset unavailable');
    const root = await fs.realpath(this.root);
    const file = await fs.realpath(contained(root, row.relativePath));
    if (!file.startsWith(root + path.sep)) throw new NotFoundException('Asset unavailable');
    return { ...row, path: file };
  }
  async copyOwned(url: string, userId: string, destination: string) {
    const source = await this.owned(url, userId);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source.path, destination);
    return destination;
  }
  async storeUpload(
    localPath: string,
    filename: string,
    mimeType: string,
    userId: string
  ): Promise<string> {
    return (await this.publish(localPath, 'uploads', filename, userId, mimeType)).url;
  }
  async publish(
    localPath: string,
    targetSubdir: string,
    targetName: string,
    userId?: string,
    contentType?: string
  ) {
    if (!userId) throw new Error('Asset publication requires an owner');
    const ext = path.extname(targetName).toLowerCase();
    const types: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.gif': 'image/gif',
    };
    if (!types[ext]) throw new Error('Unsupported output format');
    const relativePath = `${randomUUID()}${ext}`;
    const absPath = contained(this.root, relativePath);
    await fs.mkdir(this.root, { recursive: true });
    await fs.copyFile(localPath, absPath, fs.constants.COPYFILE_EXCL);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(absPath)) hash.update(chunk);
    const stat = await fs.stat(absPath);
    const repo = this.db.getRepository(LocalAsset);
    try {
      const row = await repo.save(
        repo.create({ userId, relativePath, contentType: contentType || types[ext] })
      );
      return { url: `/api/assets/${row.id}`, absPath, size: stat.size, sha256: hash.digest('hex') };
    } catch (error) {
      await fs.unlink(absPath);
      throw error;
    }
  }
  async delete(url: string, userId: string) {
    const row = await this.owned(url, userId);
    await fs.unlink(row.path);
    await this.db.getRepository(LocalAsset).delete({ id: row.id, userId });
  }
}
