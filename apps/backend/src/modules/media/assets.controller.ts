import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { StorageService } from './services/storage.service';
@Controller('assets')
@UseGuards(JwtAuthGuard)
export class AssetsController {
  constructor(private readonly storage: StorageService) {}
  @Get(':id') async read(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Res() response: Response
  ) {
    const asset = await this.storage.owned(`/api/assets/${id}`, user.sub);
    response.setHeader('Content-Type', asset.contentType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.sendFile(asset.path); // Express supports byte ranges and HEAD.
  }
}
