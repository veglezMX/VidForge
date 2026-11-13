import { Injectable } from '@nestjs/common';

export function trustedBase(value: string | undefined, label: string): URL {
  if (!value) throw new Error(`Configure ${label} in the backend environment`);
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || !['https:', 'http:'].includes(u.protocol))
    throw new Error(`Invalid ${label}`);
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
    throw new Error(`${label} requires verified HTTPS outside loopback`);
  return u;
}

@Injectable()
export class GatewayConfigService {
  alias(kind: 'text' | 'vision' | 'image' | 'video' | 'voice'): string {
    return (
      process.env[`${kind.toUpperCase()}_MODEL_ALIAS`] ||
      {
        text: 'openai-main',
        vision: 'openai-main',
        image: 'image-main',
        video: 'video-main',
        voice: 'voice-main',
      }[kind]
    );
  }
  connection(kind: 'llm' | 'media') {
    const prefix = `${kind.toUpperCase()}_GATEWAY`;
    const base = trustedBase(process.env[`${prefix}_URL`], `${prefix}_URL`);
    const key = process.env[`${prefix}_KEY`];
    if (!key) throw new Error(`Configure a scoped ${prefix}_KEY in the backend environment`);
    return { base: base.href.replace(/\/$/, ''), key };
  }
  available(kind: 'text' | 'video'): boolean {
    try {
      this.connection(kind === 'text' ? 'llm' : 'media');
      return true;
    } catch {
      return false;
    }
  }
}
