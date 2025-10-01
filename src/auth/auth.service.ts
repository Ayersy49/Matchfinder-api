// src/auth/auth.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

const normDigits = (s: string) => (s ?? '').toString().replace(/\D/g, '');

@Injectable()
export class AuthService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  // 3 dk geçerli OTP üret
  async requestOtp(phone: string) {
    const p = normDigits(phone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await this.redis.setex(`otp:${p}`, 60 * 3, code);
    console.log('[OTP] request phone=%s code=%s', p, code);
    const isProd = process.env.NODE_ENV === 'production';
    return isProd ? { ok: true } : { ok: true, code, devCode: code };
  }

  // OTP doğrula -> user upsert -> JWT(sub=user.id)
  async verifyOtp(phone: string, incomingCode: string) {
    const isProd = process.env.NODE_ENV === 'production';
    const bypass = normDigits(process.env.OTP_DEV_BYPASS_CODE || '');

    const p = normDigits(phone);
    const c = normDigits(incomingCode).slice(0, 6);

    if (!isProd && bypass && c === bypass) {
      console.log('[OTP] BYPASS OK phone=%s', p);
      return this.signIn(p);
    }

    const key = `otp:${p}`;
    const stored = normDigits((await this.redis.get(key)) || '').slice(0, 6);
    console.log('[OTP] verify phone=%s incoming=%s stored=%s', p, c, stored);

    if (!stored) return { ok: false, reason: 'OTP_expired' };
    if (stored !== c) return { ok: false, reason: 'OTP_mismatch' };

    await this.redis.del(key);
    return this.signIn(p);
  }

  private async signIn(phoneDigits: string) {
    // positions [] ve positionLevels {} ile oluştur
    const user = await this.prisma.user.upsert({
      where: { phone: phoneDigits },
      update: {},
      create: { phone: phoneDigits, positions: [], positionLevels: {} },
    });

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      phone: user.phone,
    });

    return { ok: true, accessToken };
  }
}
