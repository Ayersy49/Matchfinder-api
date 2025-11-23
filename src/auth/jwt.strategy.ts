import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req) => (req?.cookies?.token as string) || null,     // varsa cookie'den
        ExtractJwt.fromAuthHeaderAsBearerToken(),             // yoksa Authorization
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') || 'dev-secret',
    });
  }

  async validate(payload: any) {
    // payload hangi alanla gelirse gelsin normalize et
    const sub = payload?.sub ?? payload?.id ?? payload?.userId ?? null;
    const phone = payload?.phone ?? null;

    // sub yoksa yetkilendirme başarısız (401)
    if (!sub) return null;

    // UsersController getUserId: req.user.id | req.user.sub | ...
    return { id: String(sub), phone: phone ?? null };
  }


}
