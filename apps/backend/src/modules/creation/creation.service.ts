import {
  GatewayRequestRejectedError,
  SubmissionUncertainError,
} from '../ai/services/gateway-transport.service';
import { Injectable, NotFoundException, ForbiddenException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { CreationTask } from './entities/creation-task.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { RegenerateShotDto } from './dto/regenerate-shot.dto';
import { CreationGateway } from './gateway/creation.gateway';
import {
  GatewayStageStoppedError,
  GatewayVideoService,
} from '../ai/services/gateway-video.service';
import { CloudPolicyService } from '../ai/services/cloud-policy.service';
import { ComposerService } from '../media/services/composer.service';
import { QueueRunnerService } from '../queue/queue-runner.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';

@Injectable()
export class CreationService implements OnModuleInit {
  constructor(
    @InjectRepository(CreationTask) private readonly tasks: Repository<CreationTask>,
    private readonly events: CreationGateway,
    private readonly video: GatewayVideoService,
    private readonly consent: CloudPolicyService,
    private readonly composer: ComposerService,
    private readonly queue: QueueRunnerService
  ) {}
  async onModuleInit() {
    for (const task of await this.tasks.findBy({ status: In(['pending', 'processing']) })) {
      const dto = (task.result as any)?.generationOptions;
      if (dto) {
        try {
          await this.consent.assert(this.context(task));
        } catch {
          await this.tasks.update(task.id, {
            status: 'failed',
            errorMessage:
              'Cloud processing is disabled; start an explicit new run after enabling it',
          });
          continue;
        }
        await this.enqueue(task.id, dto);
      }
    }
  }
  async findAll(userId: string, spaceId?: string) {
    return this.tasks.find({
      where: { userId, ...(spaceId ? { productSpaceId: spaceId } : {}) },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }
  async findOne(userId: string, id: string) {
    const task = await this.tasks.findOneBy({ id });
    if (!task) throw new NotFoundException('Task unavailable');
    if (task.userId !== userId) throw new ForbiddenException();
    return task;
  }
  private context(task: CreationTask) {
    return { userId: task.userId, productSpaceId: task.productSpaceId, runId: task.id };
  }
  async createTask(userId: string, dto: CreateTaskDto) {
    await this.consent.assert({ userId, productSpaceId: dto.productSpaceId });
    const input = Array.isArray(dto.storyboard) ? dto.storyboard : [];
    if (!input.length || input.length > 5) throw new Error('Provide 1–5 shots');
    const storyboard = input.map((s: any, i) => ({
      id: randomUUID(),
      index: i + 1,
      description: String(s.description || ''),
      voiceover: String(s.voiceover || ''),
      caption: String(s.caption || ''),
      duration: Number(s.duration || 5.0625),
      materialId: typeof s.materialId === 'string' ? s.materialId : undefined,
      status: 'pending',
      revision: 0,
    }));
    const saved = await this.tasks.save(
      this.tasks.create({
        userId,
        productSpaceId: dto.productSpaceId,
        title: dto.title,
        storyboard,
        status: 'pending',
        progress: 0,
        result: { generationOptions: dto },
      })
    );
    await this.enqueue(saved.id, dto);
    return saved;
  }
  private async enqueue(taskId: string, dto: CreateTaskDto) {
    const task = await this.tasks.findOneByOrFail({ id: taskId });
    await this.consent.assert(this.context(task));
    const revision = (task.storyboard || []).reduce(
      (sum: number, shot: any) => sum + (shot.revision || 0),
      0
    );
    await this.queue.enqueue(
      QUEUE_NAMES.CREATION_SHOT,
      JOB_NAMES.GENERATE_SHOT,
      { taskId, dto },
      () => this.processShots(taskId, dto),
      { jobId: `creation-shot:${taskId}:${revision}`, attempts: 3 }
    );
  }
  async processShots(taskId: string, dto: CreateTaskDto) {
    const task = await this.tasks.findOneBy({ id: taskId });
    if (!task || ['completed', 'failed'].includes(task.status)) return;
    const context = this.context(task);
    await this.consent.assert(context);
    await this.tasks.update(taskId, { status: 'processing' });
    const shots: any[] = task.storyboard || [];
    for (const shot of shots) {
      if (shot.status === 'completed' && shot.videoUrl) continue;
      await this.consent.assert(context);
      if (shot.taskId && !shot.provider)
        throw new Error('Historical provider job requires an explicit new run');
      shot.status = 'generating';
      shot.provider = 'media-gateway';
      await this.tasks.update(taskId, { storyboard: shots });
      try {
        shot.videoUrl = await this.video.generateVideo({
          context,
          operationKey: `${taskId}:${shot.id}:${shot.revision || 0}`,
          prompt: shot.description,
          duration: shot.duration,
          materialId: shot.materialId,
        });
        shot.status = 'completed';
      } catch (error: any) {
        shot.errorMessage = error.message;
        const stopped =
          error instanceof GatewayStageStoppedError ||
          error instanceof SubmissionUncertainError ||
          error instanceof GatewayRequestRejectedError;
        if (stopped) shot.status = 'failed';
        await this.tasks.update(taskId, {
          storyboard: shots,
          errorMessage: error.message,
          ...(stopped ? { status: 'failed' as const } : {}),
        });
        throw error;
      }
      await this.consent.assert(context);
      await this.tasks.update(taskId, {
        storyboard: shots,
        progress: Math.floor(
          (shots.filter((s) => s.status === 'completed').length / shots.length) * 90
        ),
      });
      this.events.emitShotProgress(taskId, { shotId: shot.id, status: 'completed', progress: 100 });
    }
    await this.queue.enqueue(
      QUEUE_NAMES.CREATION_COMPOSE,
      JOB_NAMES.COMPOSE_VIDEO,
      { taskId, dto },
      () => this.processComposition(taskId, dto),
      {
        jobId: `creation-compose:${taskId}:${shots.reduce((sum, s) => sum + (s.revision || 0), 0)}`,
        attempts: 3,
      }
    );
  }
  async processComposition(taskId: string, dto: CreateTaskDto) {
    const task = await this.tasks.findOneBy({ id: taskId });
    if (!task || ['completed', 'failed'].includes(task.status)) return;
    const context = this.context(task);
    await this.consent.assert(context);
    const shots: any[] = task.storyboard || [];
    if (shots.some((s) => s.status !== 'completed'))
      throw new Error('All shots must complete before composition');
    const output = await this.composer.compose(shots, {
      ...context,
      taskId,
      title: task.title,
      ratio: (['16:9', '1:1'].includes(dto.aspectRatio) ? dto.aspectRatio : '9:16') as any,
      resolution: (dto.quality || '720p') as any,
      style: dto.style,
      burnSubtitle: dto.burnSubtitle !== false,
    });
    await this.consent.assert(context);
    const result = {
      generationOptions: dto,
      url: output.finalUrl,
      shots,
      duration: output.durationSec,
      successCount: shots.length,
      totalCount: shots.length,
    };
    await this.tasks.update(
      { id: taskId, status: 'processing' },
      { status: 'completed', progress: 100, result: result as any }
    );
    this.events.emitComplete(taskId, { status: 'completed', progress: 100, result: result as any });
  }
  async cancel(userId: string, taskId: string): Promise<{ ok: true }> {
    const task = await this.findOne(userId, taskId);
    if (['completed', 'failed'].includes(task.status)) return { ok: true };
    await this.tasks.update(taskId, { status: 'failed', errorMessage: 'Cancelled' });
    await this.video.cancelRun(taskId, userId);
    return { ok: true };
  }
  async regenerateShot(
    userId: string,
    taskId: string,
    dto: RegenerateShotDto
  ): Promise<{ ok: true }> {
    const task = await this.findOne(userId, taskId);
    await this.consent.assert({ userId, productSpaceId: task.productSpaceId });
    await this.video.cancelRun(taskId, userId);
    const shots: any[] = task.storyboard || [];
    const shot = shots.find((s) => s.id === dto.shotId);
    if (!shot) throw new NotFoundException('Shot unavailable');
    shot.revision = (shot.revision || 0) + 1;
    shot.status = 'pending';
    delete shot.videoUrl;
    delete shot.taskId;
    if (dto.description) shot.description = dto.description;
    await this.tasks.update(taskId, { status: 'pending', storyboard: shots });
    const options = (task.result as any)?.generationOptions || {
      title: task.title,
      productSpaceId: task.productSpaceId,
    };
    await this.enqueue(taskId, options);
    return { ok: true };
  }
}
