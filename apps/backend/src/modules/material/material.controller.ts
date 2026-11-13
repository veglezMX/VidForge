import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Query,
  Patch,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import { FfmpegService } from '../media/services/ffmpeg.service';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MaterialService } from './material.service';
import { CreateMaterialDto } from './dto/create-material.dto';
import { QueryMaterialDto } from './dto/query-material.dto';
import { AnalyzeMaterialDto } from './dto/analyze-material.dto';
import { SemanticSearchDto } from './dto/semantic-search.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { Material } from './entities/material.entity';
import { QueueRunnerService } from '../queue/queue-runner.service';
import { StorageService } from '../media/services/storage.service';
import { QUEUE_NAMES, JOB_NAMES } from '../queue/queue.constants';
import { assetTypeForMime, MAX_MEDIA_UPLOAD_BYTES } from './media-upload.config';

@ApiTags('素材管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('material')
export class MaterialController {
  private readonly logger = new Logger(MaterialController.name);

  constructor(
    private readonly materialService: MaterialService,
    private readonly queueRunner: QueueRunnerService,
    private readonly storageService: StorageService,
    private readonly ffmpeg: FfmpegService
  ) {}

  @Post()
  @ApiOperation({ summary: '创建素材(JSON)' })
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateMaterialDto) {
    const m = await this.materialService.create(user.sub, dto);
    return this.resolveMaterialUrls(m);
  }

  /**
   * 文件上传端点
   *
   * 接收 multipart/form-data，流程：
   * 1. Multer 使用 memoryStorage 将文件保存在内存中（不依赖本地磁盘目录）
   * 2. 写入临时文件到 storage/tmp/uploads/
   * 3. StorageService 判断是否启用 OSS：
   *    - 是 → 上传到阿里云 OSS，删除临时文件
   *    - 否 → 移动到 storage/uploads/，返回 /static/uploads/xxx 路径
   * 4. 创建素材数据库记录
   * 5. 异步入队 AI 分析
   */
  @Post('upload')
  @ApiOperation({ summary: '上传素材文件( multipart )' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = path.resolve('.processing', 'uploads');
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, _file, cb) => cb(null, randomUUID()),
      }),
      limits: { fileSize: MAX_MEDIA_UPLOAD_BYTES },
    })
  )
  async uploadFile(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Body('productSpaceId') productSpaceId?: string,
    @Body('category') category?: string,
    @Body('tags') tagsRaw?: string
  ): Promise<Material> {
    if (!file) {
      this.logger.warn('上传请求中未找到文件字段');
      throw new BadRequestException('请选择要上传的文件');
    }

    try {
      await this.materialService.assertProject(user.sub, productSpaceId);
      const kind = await this.ffmpeg.validateUpload(file.path);
      const fileUrl = await this.storageService.storeUpload(
        file.path,
        `${randomUUID()}.${kind.ext}`,
        kind.mime,
        user.sub
      );
      let material: Material;
      try {
        material = await this.materialService.create(user.sub, {
          name: file.originalname,
          type: kind.type,
          url: fileUrl,
          size: file.size,
          tags: tagsRaw
            ?.split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          category,
          productSpaceId,
        });
      } catch (error) {
        await this.storageService.delete(fileUrl, user.sub);
        throw error;
      }
      await this.enqueueAutoAnalyze(user.sub, material);
      return this.resolveMaterialUrls(material);
    } finally {
      await fs.unlink(file.path).catch(() => {});
    }
  }

  /** 上传完成后自动入队 AI 分析(异步,不阻塞返回) */
  private async enqueueAutoAnalyze(userId: string, material: Material): Promise<void> {
    if (!(await this.materialService.canAnalyze(userId, material.productSpaceId))) return;
    if (material.type === 'audio') return; // 音频暂不支持视觉分析
    await this.queueRunner.enqueue(
      QUEUE_NAMES.MATERIAL_ANALYZE,
      JOB_NAMES.ANALYZE_MATERIAL,
      { userId, materialId: material.id, category: material.category },
      // Redis 不可用时降级为进程内直接分析
      async () => {
        await this.materialService.analyzeTags(userId, material.id, {
          category: material.category,
        });
      },
      { jobId: `material-analyze:${material.id}`, attempts: 3 }
    );
  }

  @Get()
  @ApiOperation({ summary: '获取素材列表（按当前用户隔离，可选 spaceId 过滤）' })
  async findAll(@CurrentUser() user: JwtPayload, @Query() query: QueryMaterialDto) {
    const result = await this.materialService.findAll(user.sub, query);
    return { ...result, list: result.list.map((m) => this.resolveMaterialUrls(m)) };
  }

  @Get(':id')
  @ApiOperation({ summary: '获取素材详情' })
  async findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const m = await this.materialService.findOne(user.sub, id);
    return this.resolveMaterialUrls(m);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除素材' })
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.materialService.remove(user.sub, id);
  }

  @Patch(':id/analyze')
  @ApiOperation({ summary: 'AI分析素材并生成三层标签' })
  async analyze(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: AnalyzeMaterialDto
  ) {
    const m = await this.materialService.analyzeTags(user.sub, id, dto);
    return this.resolveMaterialUrls(m);
  }

  @Get('search/tags')
  @ApiOperation({ summary: '按标签层级搜索素材' })
  async searchByTags(
    @CurrentUser() user: JwtPayload,
    @Query('productCategory') productCategory?: string,
    @Query('videoMood') videoMood?: string,
    @Query('clipObjects') clipObjects?: string
  ) {
    const list = await this.materialService.searchByTags(user.sub, {
      productCategory,
      videoMood,
      clipObjects,
    });
    return list.map((m) => this.resolveMaterialUrls(m));
  }

  @Post('search/semantic')
  @ApiOperation({ summary: '语义搜索素材' })
  async semanticSearch(@CurrentUser() user: JwtPayload, @Body() dto: SemanticSearchDto) {
    const result = await this.materialService.semanticSearch(user.sub, dto);
    // semanticSearch 可能返回原始 SQL 行(snake_case)或 Material 实例(camelCase)
    if (Array.isArray(result)) {
      return result.map((m: any) => {
        if (m.url) m.url = this.storageService.resolveUrl(m.url);
        const thumb = m.thumbnail_url ?? m.thumbnailUrl;
        if (thumb) {
          m.thumbnail_url = this.storageService.resolveUrl(thumb);
          m.thumbnailUrl = m.thumbnail_url;
        }
        return m;
      });
    }
    return result;
  }

  /** 将素材 URL 从相对路径(/static/...) 解析为完整的公网 URL */
  private resolveMaterialUrls(material: Material): Material {
    // 浅拷贝避免修改 DB 实体
    const clone = Object.assign(Object.create(Object.getPrototypeOf(material)), material);
    if (clone.url) clone.url = this.storageService.resolveUrl(clone.url);
    if (clone.thumbnailUrl) clone.thumbnailUrl = this.storageService.resolveUrl(clone.thumbnailUrl);
    return clone;
  }
}
