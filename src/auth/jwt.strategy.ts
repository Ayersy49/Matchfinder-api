// src/auth/jwt.strategy.ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

// Cookie'den token çekmek için küçük yardımcı (cookie-parser gerektirmez)
const cookieExtractor = (req: Request): string | null => {
  try {
    const raw = req.headers?.cookie || '';
    if (!raw) return null;
    const m = raw.match(/(?:^|;\s*)token=([^;]+)/) || raw.match(/(?:^|;\s*)access_token=([^;]+)/);
    if (!m) return null;
    return decodeURIComponent(m[1]).replace(/^Bearer\s+/i, '').trim() || null;
  } catch {
    return null;
  }
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        cookieExtractor,
        (req: Request) => (req.headers['x-access-token'] as string) || null, // emniyet sibobu
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') || 'dev-secret',
    });
  }

  async validate(payload: any) {
    const sub   = payload?.sub ?? payload?.id ?? payload?.userId ?? null;
    const phone = payload?.phone ?? null;
    return { id: sub, sub, phone };
  }
}
