import { Injectable } from '@nestjs/common';
import { AgentState } from '../interfaces/agent-state.interface';
import { GatewayVideoService } from '../../ai/services/gateway-video.service';
import { CloudPolicyService } from '../../ai/services/cloud-policy.service';
import { ComposerService } from '../../media/services/composer.service';
@Injectable()
export class CompositionAgentService {
  constructor(
    private readonly video: GatewayVideoService,
    private readonly consent: CloudPolicyService,
    private readonly composer: ComposerService
  ) {}
  async compose(state: AgentState): Promise<Partial<AgentState>> {
    const context = {
      userId: state.userId!,
      productSpaceId: state.productSpaceId!,
      runId: state.taskId,
    };
    await this.consent.assert(context);
    const shots = state.scriptGeneration?.shots || [];
    if (!shots.length) throw new Error('No shots');
    for (const shot of shots) {
      if ((shot as any).arkTaskId && !shot.videoUrl)
        throw new Error('Historical ARK checkpoint requires an explicit new run');
      if (!shot.videoUrl)
        shot.videoUrl = await this.video.generateVideo({
          context,
          operationKey: `${state.taskId}:${shot.id}`,
          prompt: shot.description,
          duration: shot.duration,
          materialId: shot.materialId,
        });
    }
    const output = await this.composer.compose(
      shots.map((s) => ({
        id: s.id,
        index: s.order,
        videoUrl: s.videoUrl!,
        duration: s.duration,
        caption: s.caption,
        voiceover: s.script,
      })),
      {
        ...context,
        taskId: state.taskId,
        title: state.productName,
        ratio: '9:16',
        resolution: '720p',
        style: state.style,
        burnSubtitle: true,
      }
    );
    await this.consent.assert(context);
    return {
      videoComposition: {
        videoUrl: output.finalUrl,
        duration: output.durationSec,
        hasRealVideo: true,
        composed: true,
        shotResults: shots.map((s) => ({ shotId: s.id, videoUrl: s.videoUrl })),
      },
      scriptGeneration: { ...state.scriptGeneration!, shots },
    };
  }
}
