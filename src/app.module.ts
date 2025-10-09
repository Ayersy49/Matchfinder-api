// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RedisModule } from '@nestjs-modules/ioredis';

import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { MatchesModule } from './matches/matches.module';
import { MessagesModule } from './messages/messages.module';

// controller’ları import ET
import { MeController } from './me/me.controller';
import { PlayersController } from './players/players.controller';

@Module({
  imports: [
    MessagesModule,
    ConfigModule.forRoot({ isGlobal: true }),

    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('JWT_SECRET') || 'dev_fallback',
        signOptions: { expiresIn: '12h' },
      }),
    }),

    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'single',
        url: `redis://${cfg.get('REDIS_HOST', 'localhost')}:${cfg.get('REDIS_PORT', 6379)}`,
        options: {
          password: cfg.get<string>('REDIS_PASSWORD') || undefined,
          db: cfg.get<number>('REDIS_DB') ?? 0,
        },
      }),
    }),

    PrismaModule,
    UsersModule,
    AuthModule,
    MatchesModule,
  ],

  // >>> Controller’LAR BURADA <<<
  controllers: [MeController, PlayersController],
})
export class AppModule {}
