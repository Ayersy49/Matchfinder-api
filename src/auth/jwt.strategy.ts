import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

type JwtPayload = {
  id?: string;
  sub?: string;
  userId?: string;
  uid?: string;
  phone?: string;
  exp?: number;
  iat?: number;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private readonly cfg: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), // Authorization: Bearer <token>
      ignoreExpiration: false,
      secretOrKey: cfg.get<string>('JWT_SECRET', 'dev_secret_123'),
    });
  }

  // req.user içine dönecek obje
  async validate(payload: JwtPayload) {
    const id = payload?.id || payload?.sub || payload?.userId || payload?.uid;
    if (!id) {
      throw new UnauthorizedException('no_user_id_claim');
    }
    return { id: String(id), phone: payload?.phone ?? undefined };
  }
}
