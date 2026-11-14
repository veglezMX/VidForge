import { Global, Module } from '@nestjs/common';
import { GatewayConfigService } from './services/gateway-config.service';
import { GatewayTextService } from './services/gateway-text.service';
import { GatewayVisionService } from './services/gateway-vision.service';
import { GatewayVideoService } from './services/gateway-video.service';
import { GatewayTransportService } from './services/gateway-transport.service';
import { CloudPolicyService } from './services/cloud-policy.service';
import { AiController } from './ai.controller';
import { AuthModule } from '../auth/auth.module';
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AiController],
  providers: [
    GatewayConfigService,
    GatewayTextService,
    GatewayVisionService,
    GatewayVideoService,
    GatewayTransportService,
    CloudPolicyService,
  ],
  exports: [
    GatewayConfigService,
    GatewayTextService,
    GatewayVisionService,
    GatewayVideoService,
    GatewayTransportService,
    CloudPolicyService,
  ],
})
export class AiModule {}
