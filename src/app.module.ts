// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RedisModule } from '@nestjs-modules/ioredis';

import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    // .env'i global yükle
    ConfigModule.forRoot({ isGlobal: true }),

    // JWT ayarları (global)
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('JWT_SECRET') || 'dev_fallback',
        signOptions: { expiresIn: '12h' },
      }),
    }),

    // Redis bağlantısı (ioredis)
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'single',
        // ör: redis://localhost:6379
        url: `redis://${cfg.get('REDIS_HOST', 'localhost')}:${cfg.get('REDIS_PORT', 6379)}`,
        options: {
          // varsa şifre ve db numarası
          password: cfg.get<string>('REDIS_PASSWORD') || undefined,
          db: cfg.get<number>('REDIS_DB') ?? 0,
        },
      }),
    }),

    // Uygulama modülleri
    PrismaModule,
    UsersModule,
    AuthModule,
  ],
})
export class AppModule {}
