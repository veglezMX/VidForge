import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { GatewayOperation } from '../../ai/entities/gateway-operation.entity';
import { GatewayConfigService } from '../../ai/services/gateway-config.service';
import {
  GatewayTransportService,
  SubmissionUncertainError,
} from '../../ai/services/gateway-transport.service';
import { CloudContext, CloudPolicyService } from '../../ai/services/cloud-policy.service';
import { FfmpegService } from './ffmpeg.service';
import { StorageService } from './storage.service';
import { TtsSynthesisResult } from '../../../providers/provider.contracts';
@Injectable()
export class TtsService {
  readonly capability = 'tts' as const;
  constructor(
    private readonly config: GatewayConfigService,
    private readonly transport: GatewayTransportService,
    private readonly consent: CloudPolicyService,
    private readonly ffmpeg: FfmpegService,
    private readonly db: DataSource,
    private readonly storage: StorageService
  ) {}
  hasRealTts() {
    return this.config.available('video') && Boolean(process.env.SPEECH_VOICE);
  }
  async synthesize(
    text: string,
    outPath: string,
    _voice?: string,
    _speed?: number,
    context?: CloudContext
  ): Promise<TtsSynthesisResult> {
    await this.consent.assert(context);
    if (!context?.runId) throw new Error('Narration requires a persistent run');
    const voice = process.env.SPEECH_VOICE;
    if (!voice) throw new Error('Configure a supported SPEECH_VOICE before narration');
    if (!text.trim()) throw new Error('Narration text is empty');
    const body = { model: this.config.alias('voice'), input: text, voice, response_format: 'mp3' };
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const operationKey = `${context.runId}:speech:${requestHash}`;
    const repo = this.db.getRepository(GatewayOperation);
    await repo
      .createQueryBuilder()
      .insert()
      .values({
        userId: context.userId,
        productSpaceId: context.productSpaceId,
        runId: context.runId,
        operationKey,
        stage: 'speech',
        modelAlias: body.model,
        requestHash,
        status: 'pending',
      })
      .orIgnore()
      .execute();
    const operation = await repo.findOneByOrFail({ userId: context.userId, operationKey });
    if (operation.status === 'succeeded' && operation.localUrl) {
      await this.storage.copyOwned(operation.localUrl, context.userId, outPath);
    } else {
      const claim = await repo.update(
        { id: operation.id, status: 'pending' },
        { status: 'submitting' }
      );
      if (!claim.affected)
        throw new Error('Narration is cancelled or requires reconciliation before a new run');
      let publishedUrl: string | undefined;
      try {
        const data = await this.transport.request('media', '/v1/audio/speech', body, context, true);
        await fs.writeFile(outPath, Buffer.from(data));
        const media = await this.ffmpeg.validateUpload(outPath);
        if (media.type !== 'audio') throw new Error('Malformed speech output');
        await this.consent.assert(context);
        const published = await this.storage.publish(
          outPath,
          'narration',
          'voice.mp3',
          context.userId
        );
        publishedUrl = published.url;
        const updated = await repo.update(
          { id: operation.id, status: 'submitting' },
          { status: 'succeeded', localUrl: published.url }
        );
        if (!updated.affected) throw new Error('Narration cancelled before publication');
      } catch (error) {
        if (publishedUrl) await this.storage.delete(publishedUrl, context.userId);
        // The binary endpoint has no resumable job ID. Never automatically retry an uncertain purchase.
        await repo.update(
          { id: operation.id, status: 'submitting' },
          { status: error instanceof SubmissionUncertainError ? 'reconciliation' : 'failed' }
        );
        throw error;
      }
    }
    const metadata = await this.ffmpeg.probe(outPath);
    if (!Number.isFinite(metadata.durationSec) || metadata.durationSec <= 0)
      throw new Error('Malformed speech output');
    return { outPath, durationSec: metadata.durationSec, mode: 'real' };
  }
}
