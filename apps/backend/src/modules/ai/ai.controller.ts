import { GatewayVideoService } from './services/gateway-video.service';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GatewayConfigService } from './services/gateway-config.service';
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly config: GatewayConfigService,
    private readonly video: GatewayVideoService
  ) {}
  @Get('models') models() {
    return ['text', 'vision', 'image', 'video', 'voice'].map((kind: any) => ({
      key: this.config.alias(kind),
      type: kind,
      name: this.config.alias(kind),
      enabled: this.config.available(kind === 'text' || kind === 'vision' ? 'text' : 'video'),
    }));
  }
  @Get('capabilities') async capabilities() {
    return { shotDurations: await this.video.supportedDurations() };
  }
  @Get('status') status() {
    return { text: this.config.available('text'), video: this.config.available('video') };
  }
}
