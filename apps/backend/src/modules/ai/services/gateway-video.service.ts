import { VideoGenerationProvider } from '../../../providers/provider.contracts';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import axios from 'axios';
import { GatewayOperation } from '../entities/gateway-operation.entity';
import { GatewayConfigService, trustedBase } from './gateway-config.service';
import { CloudContext, CloudPolicyService } from './cloud-policy.service';
import { GatewayTransportService } from './gateway-transport.service';
import { StorageService } from '../../media/services/storage.service';
import { FfmpegService } from '../../media/services/ffmpeg.service';
import { Material } from '../../material/entities/material.entity';
export type VideoGenerationOptions = {
  ratio?: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9';
  resolution?: '480p' | '720p' | '1080p';
};
export interface ShotRequest {
  context: CloudContext;
  operationKey: string;
  prompt: string;
  duration: number;
  materialId?: string;
}
@Injectable()
export class GatewayVideoService implements VideoGenerationProvider {
  readonly capability = 'video' as const;
  constructor(
    private readonly db: DataSource,
    private readonly config: GatewayConfigService,
    private readonly transport: GatewayTransportService,
    private readonly consent: CloudPolicyService,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService
  ) {}
  async supportedDurations(): Promise<number[]> {
    const result = await this.transport.request('media', '/v1/models/capabilities');
    const model = result?.models?.find((m: any) => m.alias === this.config.alias('video'));
    if (!model?.known) throw new Error('Configure a video alias with declared capabilities');
    if (Array.isArray(model.frame_range) && model.default_fps > 0) {
      const min = model.frame_range[0] / model.default_fps;
      const max = model.frame_range[1] / model.default_fps;
      const values = Array.from(
        { length: Math.max(0, Math.floor(max) - Math.ceil(min) + 1) },
        (_, i) => Math.ceil(min) + i
      );
      return values.length ? values : [min];
    }
    if (model.max_seconds > 0) return [Math.min(5, model.max_seconds)];
    throw new Error('Video alias has no supported duration declaration');
  }
  async generateVideo(options: ShotRequest): Promise<string> {
    const { context, operationKey, prompt, duration, materialId } = options;
    await this.consent.assert(context);
    const previous = await this.db
      .getRepository(GatewayOperation)
      .findOneBy({ userId: context.userId, operationKey: `${operationKey}:video` });
    if (previous) {
      if (previous.status === 'succeeded' && previous.localUrl) return previous.localUrl;
      if (previous.status !== 'pending')
        return (await this.stage(context, `${operationKey}:video`, 'video', {})).localUrl!;
    }
    // Validate requested duration before either billable stage.
    await this.transport.request('media', '/v1/media/validate', {
      model: this.config.alias('video'),
      modality: 'video',
      input: { prompt, duration_s: duration },
    });
    let inputId: string;
    if (materialId) {
      const material = await this.db.getRepository(Material).findOneBy({
        id: materialId,
        userId: context.userId,
        productSpaceId: context.productSpaceId,
      });
      if (!material || material.type !== 'image')
        throw new Error('Select an image owned by this project');
      const asset = await this.storage.owned(material.url, context.userId);
      if ((await fs.stat(asset.path)).size > 10 * 1024 * 1024)
        throw new Error('Input image exceeds 10 MiB');
      const uploaded = await this.transport.request(
        'media',
        '/v1/assets',
        await fs.readFile(asset.path),
        context
      );
      if (typeof uploaded?.asset_id !== 'string') throw new Error('Malformed input asset response');
      inputId = uploaded.asset_id;
    } else {
      const frame = await this.stage(context, `${operationKey}:frame`, 'image', { prompt });
      if (!frame.gatewayAssetId) throw new Error('Generated frame has no stable asset reference');
      inputId = frame.gatewayAssetId;
    }
    return (
      await this.stage(context, `${operationKey}:video`, 'video', {
        prompt,
        duration_s: duration,
        input_asset_id: inputId,
      })
    ).localUrl!;
  }
  private async stage(
    context: CloudContext,
    operationKey: string,
    stage: 'image' | 'video',
    input: Record<string, unknown>
  ): Promise<GatewayOperation> {
    const repo = this.db.getRepository(GatewayOperation);
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await repo
      .createQueryBuilder()
      .insert()
      .values({
        userId: context.userId,
        productSpaceId: context.productSpaceId,
        runId: context.runId!,
        operationKey,
        stage,
        modelAlias: this.config.alias(stage),
        requestHash,
        status: 'pending',
      })
      .orIgnore()
      .execute();
    let operation = await repo.findOneByOrFail({ userId: context.userId, operationKey });
    // Input IDs may expire and be re-uploaded; an already accepted video always resumes its original ID.
    if (operation.status === 'succeeded' && operation.localUrl) return operation;
    if (['cancelled', 'failed', 'reconciliation'].includes(operation.status))
      throw new Error(`Generation ${operation.status}; start an explicit new run after review`);
    if (!operation.remoteJobId) {
      const claim = await repo.update(
        { id: operation.id, status: 'pending' },
        { status: 'submitting' }
      );
      if (!claim.affected) throw new Error('Submission is in progress or requires reconciliation');
      try {
        await this.consent.assert(context);
        const result = await this.transport.request(
          'media',
          '/v1/media/generations',
          {
            model: operation.modelAlias,
            modality: stage,
            input,
            idempotency_key: operation.id,
          },
          context
        );
        if (typeof result?.job_id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.job_id))
          throw new Error('Malformed gateway job response');
        operation.remoteJobId = result.job_id;
        // Preserve a racing cancellation, but retain the remote ID for cancellation delivery.
        await repo.update(operation.id, { remoteJobId: result.job_id });
        const updated = await repo.update(
          { id: operation.id, status: 'submitting' },
          { status: 'running' }
        );
        if (!updated.affected) {
          await this.cancelRemote(operation);
          throw new Error('Generation cancelled');
        }
      } catch (error) {
        await repo.update({ id: operation.id, status: 'submitting' }, { status: 'reconciliation' });
        throw error;
      }
    }
    const until = Date.now() + 20 * 60 * 1000;
    while (Date.now() < until) {
      try {
        await this.consent.assert(context);
      } catch (error) {
        await this.cancelRun(context.runId!, context.userId);
        throw error;
      }
      operation = await repo.findOneByOrFail({ id: operation.id });
      if (operation.status === 'cancelled') {
        await this.cancelRemote(operation);
        throw new Error('Generation cancelled');
      }
      const result = await this.transport.request('media', `/v1/jobs/${operation.remoteJobId}`);
      if (['failed', 'cancelled', 'reconciliation'].includes(result?.status)) {
        await repo.update(operation.id, { status: result.status });
        throw new Error(`Gateway job ${result.status}`);
      }
      if (result?.status === 'succeeded') {
        const asset = result.assets?.[0];
        if (!asset || typeof asset.url !== 'string' || typeof asset.asset_id !== 'string')
          throw new Error('Malformed gateway asset response');
        const workId = `${operation.id}-${randomUUID()}`;
        const work = await this.storage.createTaskWorkdir('gateway', workId);
        let url: string | undefined;
        try {
          const file = path.join(work, stage === 'image' ? 'frame.png' : 'video.mp4');
          await this.download(asset.url, file);
          const validated = await this.ffmpeg.validateUpload(file);
          if (validated.type !== stage) throw new Error('Unexpected gateway asset content');
          await this.consent.assert(context);
          const published = await this.storage.publish(
            file,
            'generated',
            `output.${validated.ext}`,
            context.userId,
            validated.mime
          );
          url = published.url;
          const written = await repo.update(
            { id: operation.id, status: 'running' },
            { status: 'succeeded', localUrl: url, gatewayAssetId: asset.asset_id }
          );
          if (!written.affected) {
            await this.storage.delete(url, context.userId);
            throw new Error('Generation cancelled before publication');
          }
          return await repo.findOneByOrFail({ id: operation.id });
        } finally {
          await this.storage.cleanupTaskWorkdir('gateway', workId);
        }
      }
      if (!['queued', 'running'].includes(result?.status))
        throw new Error('Malformed gateway status');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Polling paused; resume this run to continue the existing job');
  }
  async download(url: string, file: string) {
    const candidate = new URL(url);
    const allowed = (process.env.ASSET_STORE_ORIGINS || '')
      .split(',')
      .filter(Boolean)
      .map((s) => trustedBase(s.trim(), 'ASSET_STORE_ORIGINS').origin);
    allowed.push(new URL(this.config.connection('media').base).origin);
    if (candidate.username || candidate.password || !allowed.includes(candidate.origin))
      throw new Error('Untrusted asset origin');
    const response = await axios.get(url, {
      responseType: 'stream',
      maxRedirects: 0,
      timeout: 60000,
      proxy: false,
    });
    const { pipeline } = await import('node:stream/promises');
    const { Transform } = await import('node:stream');
    const { createWriteStream } = await import('node:fs');
    let bytes = 0;
    try {
      await pipeline(
        response.data,
        new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > 100 * 1024 * 1024 ? new Error('Asset too large') : null, chunk);
          },
        }),
        createWriteStream(file, { flags: 'wx' })
      );
    } catch (error) {
      response.data.destroy();
      await fs.unlink(file).catch(() => {});
      throw new Error('Asset download failed');
    }
  }
  private async cancelRemote(op: GatewayOperation) {
    if (op.remoteJobId)
      await this.transport.request('media', `/v1/jobs/${op.remoteJobId}/cancel`, {});
  }
  async cancelRun(runId: string, userId: string) {
    await this.cancelWhere({ runId, userId });
  }
  async cancelProject(productSpaceId: string, userId: string) {
    await this.cancelWhere({ productSpaceId, userId });
  }
  private async cancelWhere(where: Record<string, string>) {
    const repo = this.db.getRepository(GatewayOperation);
    const operations = await repo.findBy(where);
    for (const op of operations) {
      if (['succeeded', 'failed'].includes(op.status)) continue;
      await repo.update(op.id, { status: 'cancelled' });
    }
    await Promise.allSettled(
      operations
        .filter((op) => !['succeeded', 'failed'].includes(op.status))
        .map((op) => this.cancelRemote(op))
    );
  }
}
