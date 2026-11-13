import { Injectable, UnauthorizedException, ExecutionContext, CanActivate } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { JwtPayload } from './interfaces/jwt-payload.interface';
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService
  ) {}
  async verify(token: string): Promise<JwtPayload> {
    try {
      const payload = this.jwt.verify<JwtPayload>(token);
      const user = await this.auth.findById(payload.sub);
      if (!user?.isActive || payload.sessionVersion !== (user.sessionVersion || 0))
        throw new Error();
      return { ...payload, role: user.role };
    } catch {
      throw new UnauthorizedException('Session expired or revoked');
    }
  }
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    let token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    // Media tags cannot set Authorization; the HttpOnly cookie is accepted only for asset reads.
    if (
      !token &&
      ['GET', 'HEAD'].includes(req.method) &&
      /^\/api\/assets\//.test(req.originalUrl)
    ) {
      token =
        String(req.headers.cookie || '')
          .split(';')
          .map((s: string) => s.trim())
          .find((s: string) => s.startsWith('vidforge_asset='))
          ?.slice(15) || '';
    }
    req.user = await this.verify(token);
    return true;
  }
}
