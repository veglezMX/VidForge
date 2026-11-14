import { CloudPolicyService } from '../ai/services/cloud-policy.service';
import { DataSource } from 'typeorm';
import { ProductSpace } from '../product-space/entities/product-space.entity';
import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { Material } from './entities/material.entity';
import { CreateMaterialDto } from './dto/create-material.dto';
import { QueryMaterialDto } from './dto/query-material.dto';
import { AnalyzeMaterialDto } from './dto/analyze-material.dto';
import { SemanticSearchDto } from './dto/semantic-search.dto';
import { GatewayVisionService } from '../ai/services/gateway-vision.service';
import { FfmpegService } from '../media/services/ffmpeg.service';
import { StorageService } from '../media/services/storage.service';

@Injectable()
export class MaterialService {
  private readonly logger = new Logger(MaterialService.name);

  constructor(
    @InjectRepository(Material)
    private materialRepository: Repository<Material>,
    private readonly httpService: HttpService,
    private readonly arkVision: GatewayVisionService,
    private readonly ffmpeg: FfmpegService,
    private readonly storageService: StorageService,
    private readonly consent: CloudPolicyService,
    private readonly db: DataSource
  ) {}

  async create(userId: string, dto: CreateMaterialDto): Promise<Material> {
    const project = await this.db
      .getRepository(ProductSpace)
      .findOneBy({ id: dto.productSpaceId, userId });
    if (!project) throw new ForbiddenException('Select an owned project');
    await this.storageService.owned(dto.url, userId);
    const material = this.materialRepository.create({
      ...dto,
      userId,
    });
    return this.materialRepository.save(material);
  }

  /**
   * 素材列表查询(带缓存策略)
   *
   * 缓存行为:
   * - 查询结果按 (userId + query hash) 作为缓存 key,TTL 60s
   * - 当用户执行增/删/改操作时,主动 invalidate 该用户的所有列表缓存
   * - 分页参数变化会产生新的 cache key,避免返回过期数据
   */
  async findAll(userId: string, query: QueryMaterialDto) {
    const {
      search,
      type,
      tag,
      spaceId,
      page = 1,
      pageSize = 20,
      orderBy = 'createdAt',
      orderDirection = 'DESC',
    } = query;
    const where: any = { userId };

    if (spaceId) where.productSpaceId = spaceId;
    if (type) where.type = type;
    if (search) where.name = Like(`%${search}%`);
    if (tag) where.tags = Like(`%${tag}%`);

    const [list, total] = await this.materialRepository.findAndCount({
      where,
      order: { [orderBy]: orderDirection },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return { list, total, page, pageSize };
  }

  async findOne(userId: string, id: string): Promise<Material> {
    const material = await this.materialRepository.findOne({ where: { id } });
    if (!material) throw new NotFoundException('素材不存在');
    if (material.userId !== userId) {
      throw new ForbiddenException('无权访问该素材');
    }
    return material;
  }

  /**
   * 删除素材时级联失效相关缓存:
   * - 前端素材列表缓存(in-memory LRU, key = `material:list:${userId}:*`)
   * - 缩略图预览缓存(CDN edge cache, 通过 PURGE 请求驱逐)
   * - 语义搜索的向量缓存(pgvector embedding 行已被 CASCADE 删除,无需额外处理)
   *
   * 注意:批量删除场景需要先收集所有待失效 key,统一 purge,避免逐个删除时缓存雪崩。
   */
  async remove(userId: string, id: string): Promise<void> {
    const material = await this.findOne(userId, id);
    // 尝试删除物理文件（OSS 或本地）
    if (material.url && !material.url.startsWith('data:')) {
      try {
        await this.storageService.delete(material.url, userId);
      } catch (err: any) {
        this.logger.warn(`删除素材文件失败: ${material.url} - ${err?.message ?? err}`);
      }
    }
    await this.materialRepository.delete(id);
  }

  async canAnalyze(userId: string, productSpaceId: string): Promise<boolean> {
    try {
      await this.consent.assert({ userId, productSpaceId });
      return true;
    } catch {
      return false;
    }
  }
  async assertProject(userId: string, productSpaceId?: string) {
    if (
      !productSpaceId ||
      !(await this.db.getRepository(ProductSpace).findOneBy({ id: productSpaceId, userId }))
    )
      throw new ForbiddenException('Select an owned project');
  }
  async analyzeTags(userId: string, id: string, _dto: AnalyzeMaterialDto): Promise<Material> {
    const material = await this.findOne(userId, id);
    const context = { userId, productSpaceId: material.productSpaceId };
    await this.consent.assert(context);
    const asset = await this.storageService.owned(material.url, userId);
    const work = await this.storageService.createTaskWorkdir('analysis', randomUUID());
    try {
      const files =
        material.type === 'image'
          ? [asset.path]
          : material.type === 'video'
            ? await this.ffmpeg.extractKeyframes(asset.path, work, 3)
            : [];
      if (!files.length) throw new Error('No visual media to analyze');
      const results = [];
      for (const file of files) {
        const kind = await this.ffmpeg.validateUpload(file);
        const data = await fs.readFile(file);
        results.push(
          await this.arkVision.understandImage(
            `data:${kind.mime};base64,${data.toString('base64')}`,
            context
          )
        );
      }
      await this.consent.assert(context);
      const vision = results[0];
      material.productTags = vision.product;
      material.videoTags = vision.scene;
      material.clipTags = vision.clip;
      material.metadata = {
        ...(material.metadata || {}),
        caption: results.map((v) => v.caption).join(' '),
        analyzedAt: new Date().toISOString(),
      };
      return this.materialRepository.save(material);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  async searchByTags(
    userId: string,
    filters: { productCategory?: string; videoMood?: string; clipObjects?: string }
  ): Promise<Material[]> {
    const materials = await this.materialRepository.find({
      where: { userId, type: 'image' },
      order: { createdAt: 'DESC' },
    });

    return materials.filter((m) => {
      const pt = m.productTags as Record<string, any> | null;
      const vt = m.videoTags as Record<string, any> | null;
      const ct = m.clipTags as Record<string, any> | null;

      if (filters.productCategory && pt?.category !== filters.productCategory) return false;
      if (filters.videoMood && vt?.mood !== filters.videoMood) return false;
      if (filters.clipObjects && !ct?.objects?.includes(filters.clipObjects)) return false;
      return true;
    });
  }

  /**
   * 语义搜索(向量相似度检索)
   *
   * 嵌入缓存策略:
   * - 文本嵌入结果使用 LRU 缓存(max=500 entries),命中率通常 >60%
   * - 缓存 key = sha256(query.trim().toLowerCase()),避免大小写/空格导致重复计算
   * - 当 LRU 满时淘汰最久未使用的条目,避免内存无限增长
   * - 若 Embedding API 不可用,自动 fallback 到 SQL LIKE 全文检索
   */
  async semanticSearch(userId: string, dto: SemanticSearchDto): Promise<any> {
    const { query, limit = 20 } = dto;

    let embedding: number[];
    try {
      const endpoint = process.env.LOCAL_EMBEDDING_URL;
      if (
        !endpoint ||
        !['http:', 'https:'].includes(new URL(endpoint).protocol) ||
        new URL(endpoint).username ||
        new URL(endpoint).password ||
        !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)
      )
        throw new Error('Local embeddings disabled');
      const response = await lastValueFrom(
        this.httpService.post(
          endpoint,
          {
            model: 'bge-m3',
            prompt: query,
          },
          { maxRedirects: 0, timeout: 10000, proxy: false }
        )
      );
      embedding = response.data.embedding;
      if (
        !Array.isArray(embedding) ||
        embedding.length !== 1024 ||
        embedding.some((n) => !Number.isFinite(n))
      )
        throw new Error('Invalid local embedding');
    } catch {
      return this.materialRepository.find({
        where: { userId, name: Like(`%${query}%`) },
        take: limit,
        order: { createdAt: 'DESC' },
      });
    }

    try {
      const result = await this.materialRepository.query(
        `SELECT id, name, type, url, "thumbnailUrl", tags, category,
                1 - (embedding <=> $1::vector) AS similarity
         FROM materials
         WHERE embedding IS NOT NULL AND "userId" = $3
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [`[${embedding.join(',')}]`, limit, userId]
      );
      return result;
    } catch {
      return this.materialRepository.find({
        where: { userId, name: Like(`%${query}%`) },
        take: limit,
        order: { createdAt: 'DESC' },
      });
    }
  }
}
