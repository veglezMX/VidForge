import { Injectable } from '@nestjs/common';
import { TextProviderRequest } from '../../../providers/provider.contracts';
import { GatewayConfigService } from './gateway-config.service';
import { GatewayTransportService } from './gateway-transport.service';
import { CloudContext, CloudPolicyService } from './cloud-policy.service';

@Injectable()
export class GatewayTextService {
  readonly capability = 'text' as const;
  constructor(
    private readonly config: GatewayConfigService,
    private readonly transport: GatewayTransportService,
    private readonly consent: CloudPolicyService
  ) {}
  async chatCompletion(
    options: TextProviderRequest & { context?: CloudContext; vision?: boolean }
  ): Promise<{ text: string }> {
    await this.consent.assert(options.context);
    const data = await this.transport.request(
      'llm',
      '/v1/chat/completions',
      {
        model: this.config.alias(options.vision ? 'vision' : 'text'),
        messages: options.messages,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      },
      options.context
    );
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim())
      throw new Error('Gateway returned malformed text');
    return { text };
  }
}
