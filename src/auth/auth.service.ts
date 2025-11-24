// src/auth/auth.service.ts
import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

const normDigits = (s: string) => (s ?? '').toString().replace(/\D/g, '');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly LOG_OTP = process.env.LOG_OTP === '1';
  private readonly OTP_TTL_SEC = Number(process.env.OTP_TTL_SEC || 180);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /* ================== OTP FLOW ================== */

  async requestOtp(phone: string) {
    const p = normDigits(phone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await this.redis.setex(`otp:${p}`, this.OTP_TTL_SEC, code);

    if (this.LOG_OTP) {
      this.logger.debug(`[OTP] request phone=${p} code=${code}`);
    }

    const isProd = process.env.NODE_ENV === 'production';
    return isProd ? { ok: true } : { ok: true, code, devCode: code };
  }

  /**
   * OTP doğrula -> user upsert -> JWT döner
   * Response: { ok, accessToken, isNew, hasPassword, phone }
   */
  async verifyOtp(phone: string, incomingCode: string) {
    const isProd = process.env.NODE_ENV === 'production';
    const bypass = normDigits(process.env.OTP_DEV_BYPASS_CODE || '');

    const p = normDigits(phone);
    const c = normDigits(incomingCode).slice(0, 6);

    // Dev bypass
    if (!isProd && bypass && c === bypass) {
      if (this.LOG_OTP) this.logger.debug(`[OTP] BYPASS OK phone=${p}`);
      return this.createSession(p);
    }

    const key = `otp:${p}`;
    const stored = normDigits((await this.redis.get(key)) || '').slice(0, 6);

    if (this.LOG_OTP) {
      this.logger.debug(`[OTP] verify phone=${p} incoming=${c} stored=${stored}`);
    }

    if (!stored) return { ok: false, reason: 'OTP_expired' };
    if (stored !== c) return { ok: false, reason: 'OTP_mismatch' };

    await this.redis.del(key);
    return this.createSession(p);
  }

  /**
   * Oturum oluştur ve kullanıcı durumunu dön
   */
  private async createSession(phoneDigits: string) {
    // Kullanıcıyı bul veya oluştur
    let user = await this.prisma.user.findUnique({
      where: { phone: phoneDigits },
    });

    const isNew = !user;

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phone: phoneDigits,
          positions: [],
          positionLevels: {},
        },
      });
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      phone: user.phone,
    });

    return {
      ok: true,
      accessToken,
      isNew,
      hasPassword: !!user.password,
      hasUsername: !!user.username,
      phone: user.phone,
      username: user.username,
    };
  }

  /* ================== İLK KAYIT: USERNAME + PASSWORD ================== */

  /**
   * İlk kez giriş yapan kullanıcı için username + password belirle
   * OTP doğrulandıktan sonra çağrılır
   */
  async setCredentials(
    userId: string,
    username: string,
    password: string,
  ): Promise<{ ok: boolean; accessToken?: string; message?: string }> {
    // Validasyonlar
    if (!username || username.length < 3) {
      throw new BadRequestException('Kullanıcı adı en az 3 karakter olmalı');
    }
    if (username.length > 24) {
      throw new BadRequestException('Kullanıcı adı en fazla 24 karakter olabilir');
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      throw new BadRequestException('Kullanıcı adı sadece harf, rakam ve _ içerebilir');
    }
    if (!password || password.length < 6) {
      throw new BadRequestException('Şifre en az 6 karakter olmalı');
    }

    // Kullanıcıyı bul
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('Kullanıcı bulunamadı');
    }

    // Zaten şifresi varsa hata ver (bu endpoint sadece ilk kayıt için)
    if (user.password) {
      throw new BadRequestException('Bu hesapta zaten şifre tanımlı. Şifre değiştirmek için profil sayfasını kullanın.');
    }

    // Username unique mi?
    const existing = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
    });
    if (existing && existing.id !== userId) {
      throw new ConflictException('Bu kullanıcı adı zaten kullanılıyor');
    }

    // Hash password ve kaydet
    const hash = await bcrypt.hash(password, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        username: username.toLowerCase(),
        password: hash,
      },
    });

    // Yeni token oluştur (username bilgisiyle)
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      phone: user.phone,
      username: username.toLowerCase(),
    });

    return { ok: true, accessToken };
  }

  /* ================== ŞİFRE İLE GİRİŞ ================== */

  /**
   * Telefon veya username + şifre ile giriş
   */
  async loginWithPassword(identifier: string, plain: string) {
    if (!identifier || !plain) {
      return { ok: false, reason: 'invalid_credentials' };
    }

    // identifier: phone veya username olabilir
    const normalized = identifier.trim().toLowerCase();
    const isPhone = /^\d+$/.test(normalized) || normalized.startsWith('+');
    const phoneDigits = isPhone ? normDigits(normalized) : undefined;

    // Kullanıcıyı bul
    const user = await this.prisma.user.findFirst({
      where: isPhone
        ? { phone: phoneDigits }
        : { username: normalized },
    });

    if (!user) {
      return { ok: false, reason: 'invalid_credentials' };
    }

    if (!user.password) {
      return { ok: false, reason: 'no_password', message: 'Bu hesapta şifre tanımlı değil. OTP ile giriş yapın.' };
    }

    const match = await bcrypt.compare(plain, user.password);
    if (!match) {
      return { ok: false, reason: 'invalid_credentials' };
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      phone: user.phone,
      username: user.username,
    });

    return {
      ok: true,
      accessToken,
      phone: user.phone,
      username: user.username,
    };
  }

  /* ================== ŞİFRE DEĞİŞTİRME ================== */

  /**
   * Mevcut şifreyi değiştir (zaten şifresi olan kullanıcılar için)
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('Yeni şifre en az 6 karakter olmalı');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('Kullanıcı bulunamadı');
    }

    // Mevcut şifre kontrolü
    if (user.password) {
      if (!currentPassword) {
        throw new BadRequestException('Mevcut şifrenizi girmelisiniz');
      }
      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match) {
        throw new BadRequestException('Mevcut şifre hatalı');
      }
    }

    const hash = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hash },
    });

    return { ok: true };
  }

  /* ================== KULLANICI ADI KONTROLÜ ================== */

  /**
   * Username müsait mi kontrol et
   */
  async checkUsername(username: string, excludeUserId?: string): Promise<{ available: boolean }> {
    if (!username || username.length < 3) {
      return { available: false };
    }

    const normalized = username.toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { username: normalized },
    });

    if (!existing) {
      return { available: true };
    }

    // Kendi username'i ise müsait say
    if (excludeUserId && existing.id === excludeUserId) {
      return { available: true };
    }

    return { available: false };
  }
}
