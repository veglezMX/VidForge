import { Injectable } from '@nestjs/common';
import { GatewayTextService } from './gateway-text.service';
import { CloudContext } from './cloud-policy.service';
export interface VisionUnderstandResult {
  /** 商品维度 */
  product: {
    /** 主体名称(如"无线耳机") */
    name?: string;
    /** 类目(3C/美妆/服饰/食品/家居 等) */
    category?: string;
    /** 品牌(若可识别) */
    brand?: string | null;
    /** 颜色集(主色 hex) */
    colors?: string[];
    /** 材质 */
    material?: string;
  };
  /** 画面/视频维度 */
  scene: {
    /** 场景类型(室内/户外/演播室/手持/特写) */
    scene?: string;
    /** 镜头(特写/中景/全景) */
    shot?: string;
    /** 构图(居中/对角线/三分) */
    composition?: string;
    /** 光线(柔光/硬光/逆光) */
    lighting?: string;
    /** 风格(写实/极简/复古/科技) */
    style?: string;
  };
  /** 剪辑维度(供检索) */
  clip: {
    /** 主要物体 / 元素 */
    objects?: string[];
    /** 文字内容(若有 OCR 风险也只返回主要可读文本) */
    text?: string | null;
    /** 情绪标签(欢快/沉静/紧张/温暖) */
    mood?: string;
    /** 适合的视频用途(开场/卖点/演示/CTA) */
    suitableFor?: string[];
  };
  /** 模型对图片的一句话描述,作为后续 embedding 输入 */
  caption: string;
}

const VISION_SYSTEM_PROMPT = `你是电商带货视频的素材标注专家。
对输入图片做多维度结构化分析,严格只输出 JSON,不要解释。
要求 JSON 结构:
{
  "product": { "name": string?, "category": string?, "brand": string|null, "colors": string[]?, "material": string? },
  "scene":   { "scene": string?, "shot": string?, "composition": string?, "lighting": string?, "style": string? },
  "clip":    { "objects": string[]?, "text": string|null, "mood": string?, "suitableFor": string[]? },
  "caption": string
}
注意:
- caption 用一句话(<=30字)描述画面,适合作为后续向量检索的输入
- category 限定在: 3C数码 / 美妆个护 / 服饰鞋包 / 食品饮料 / 家居家电 / 母婴 / 运动户外 / 其他
- mood 限定在: 欢快 / 温暖 / 高级 / 紧张 / 清新 / 神秘
- suitableFor 限定在: 开场hook / 卖点演示 / 使用场景 / 用户证言 / CTA 中的若干项
- 不要有 markdown,不要有 \`\`\`,只输出纯 JSON`;

@Injectable()
export class GatewayVisionService {
  constructor(private readonly text: GatewayTextService) {}
  async understandImage(dataUrl: string, context: CloudContext): Promise<VisionUnderstandResult> {
    if (
      !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) ||
      dataUrl.length > 14 * 1024 * 1024
    )
      throw new Error('Vision requires validated local image bytes');
    const result = await this.text.chatCompletion({
      context,
      vision: true,
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] },
      ],
      temperature: 0.2,
      maxTokens: 1000,
    });
    const value = JSON.parse(
      result.text
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, '')
    );
    if (!value || typeof value.caption !== 'string' || !value.caption.trim())
      throw new Error('Invalid vision response');
    for (const field of ['product', 'scene', 'clip']) {
      if (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field]))
        throw new Error('Invalid vision response');
      for (const [key, item] of Object.entries(value[field])) {
        if (['colors', 'objects', 'suitableFor'].includes(key)) {
          if (!Array.isArray(item) || item.length > 30 || item.some((x) => typeof x !== 'string'))
            throw new Error('Invalid vision tags');
        } else if (item !== null && typeof item !== 'string')
          throw new Error('Invalid vision field');
      }
    }
    return value;
  }
}
