import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') || 'dev-secret',
    });
  }

  async validate(payload: any) {
    // Token içindeki alanları normalize et
    const sub = payload?.sub ?? payload?.id ?? payload?.userId ?? null;
    const phone = payload?.phone ?? null;

    // Guard, return ettiğinizi req.user içine koyar
    // UsersController 'req.user.sub' ve 'req.user.phone' bekliyor
    return { id: payload.sub, phone: payload.phone }; 
  }

}
