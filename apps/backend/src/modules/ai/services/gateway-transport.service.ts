import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { GatewayConfigService } from './gateway-config.service';
import { CloudContext, CloudPolicyService } from './cloud-policy.service';

export class GatewayRequestRejectedError extends Error {}

export class SubmissionUncertainError extends Error {
  constructor() {
    super('Submission outcome is unknown. Reconciliation is required before a new billable run.');
  }
}
@Injectable()
export class GatewayTransportService {
  constructor(
    private readonly config: GatewayConfigService,
    private readonly consent: CloudPolicyService
  ) {}
  async request(
    kind: 'llm' | 'media',
    route: string,
    body?: unknown,
    context?: CloudContext,
    binary = false
  ): Promise<any> {
    if (!/^\/v1\/[a-zA-Z0-9/_-]+$/.test(route)) throw new Error('Invalid gateway route');
    const { base, key } = this.config.connection(kind);
    if (context) await this.consent.assert(context);
    try {
      const response = await axios.request({
        url: base + route,
        method: body === undefined ? 'GET' : 'POST',
        data: body,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
        },
        timeout: 120000,
        maxRedirects: 0,
        maxBodyLength: 16 * 1024 * 1024,
        maxContentLength: 32 * 1024 * 1024,
        responseType: binary ? 'arraybuffer' : 'json',
        proxy: false,
      });
      return response.data;
    } catch (error: any) {
      // Never return/log axios config, request headers, URLs or provider response bodies.
      if (body !== undefined && (!error.response || error.response.status >= 500))
        throw new SubmissionUncertainError();
      const message = `Gateway request failed (${error.response?.status ?? 'unavailable'}). Check configuration, budget and supported options.`;
      if (error.response?.status >= 400 && error.response.status < 500)
        throw new GatewayRequestRejectedError(message);
      throw new Error(message);
    }
  }
}
