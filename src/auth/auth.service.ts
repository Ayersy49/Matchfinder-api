import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly jwt: JwtService,
  ) {}

  // 3 dakika geçerli OTP üret
  async requestOtp(phone: string) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // ÖNEMLİ: OTP'yi Redis'e yaz ve süresini ayarla (EX = saniye)
    // Key: otp:<telefon>
    await this.redis.set(`otp:${phone}`, code, 'EX', 180);

    // local geliştirme için devCode döndürüyoruz ki ekranda görebilin
    return { ok: true, devCode: code };
  }

  async verifyOtp(phone: string, code: string) {
    // Redis'ten oku
    const stored = await this.redis.get(`otp:${phone}`);

    if (!stored) {
      return { ok: false, reason: 'OTP_exired_or_missing' };
    }
    if (stored !== code) {
      return { ok: false, reason: 'OTP_mismatch' };
    }

    // Doğrulandı: kodu bir daha kullanılmasın diye sil
    await this.redis.del(`otp:${phone}`);

    // Token üret (örnek payload)
    const accessToken = await this.jwt.signAsync({ sub: phone });

    return { ok: true, accessToken };
  }
}
