// src/auth/auth.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

const normDigits = (s: string) => (s ?? '').toString().replace(/\D/g, '');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // ENV ile aç/kapat: LOG_OTP=1 → debug logları açık
  private readonly LOG_OTP = process.env.LOG_OTP === '1';
  // OTP süresi: varsayılan 180 sn
  private readonly OTP_TTL_SEC = Number(process.env.OTP_TTL_SEC || 180);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) { }

  // 3 dk (veya OTP_TTL_SEC) geçerli OTP üret
  async requestOtp(phone: string) {
    const p = normDigits(phone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await this.redis.setex(`otp:${p}`, this.OTP_TTL_SEC, code);

    if (this.LOG_OTP) {
      this.logger.debug(`[OTP] request phone=${p} code=${code}`);
    }

    const isProd = process.env.NODE_ENV === 'production';
    // prod'da kodu dönme; dev’de geri ver
    return isProd ? { ok: true } : { ok: true, code, devCode: code };
  }

  // OTP doğrula -> user upsert -> JWT(sub=user.id)
  async verifyOtp(phone: string, incomingCode: string) {
    const isProd = process.env.NODE_ENV === 'production';
    const bypass = normDigits(process.env.OTP_DEV_BYPASS_CODE || '');

    const p = normDigits(phone);
    const c = normDigits(incomingCode).slice(0, 6);

    // Dev bypass (örn. OTP_DEV_BYPASS_CODE=000000)
    if (!isProd && bypass && c === bypass) {
      if (this.LOG_OTP) this.logger.debug(`[OTP] BYPASS OK phone=${p}`);
      return this.signIn(p);
    }

    const key = `otp:${p}`;
    const stored = normDigits((await this.redis.get(key)) || '').slice(0, 6);

    if (this.LOG_OTP) {
      this.logger.debug(`[OTP] verify phone=${p} incoming=${c} stored=${stored}`);
    }

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

    return { ok: true, accessToken, isNew: user.createdAt.getTime() > Date.now() - 10000 };
  }

  /* ---------------- PASSWORD AUTH ---------------- */

  async loginWithPassword(identifier: string, plain: string) {
    // identifier: phone or username
    // Phone ise normDigits yap
    const isPhone = /^\d+$/.test(identifier) || identifier.startsWith('+');
    const phone = isPhone ? normDigits(identifier) : undefined;
    const username = !isPhone ? identifier : undefined;

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { phone: phone ? phone : undefined },
          { username: username ? username : undefined } as any,
        ],
      },
    });

    if (!user || !(user as any).password) {
      return { ok: false, reason: 'invalid_credentials' };
    }

    const match = await import('bcrypt').then(m => m.compare(plain, (user as any).password!));
    if (!match) {
      return { ok: false, reason: 'invalid_credentials' };
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      phone: user.phone,
    });

    return { ok: true, accessToken };
  }

  async setPassword(userId: string, plain: string, currentPassword?: string) {
    if (!plain || plain.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    // Eğer kullanıcının zaten şifresi varsa, mevcut şifreyi doğrula
    if ((user as any).password) {
      if (!currentPassword) {
        throw new Error('Mevcut şifrenizi girmelisiniz.');
      }
      const match = await import('bcrypt').then(m => m.compare(currentPassword, (user as any).password!));
      if (!match) {
        throw new Error('Mevcut şifre hatalı.');
      }
    }

    const hash = await import('bcrypt').then(m => m.hash(plain, 10));
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hash } as any,
    });

    // Bildirim oluştur
    await this.prisma.notification.create({
      data: {
        userId,
        type: 'PASSWORD_CHANGED',
        data: {},
      },
    });

    return { ok: true };
  }
}
