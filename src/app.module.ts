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
import { FriendsModule } from './friends/friends.module';
import { InvitesModule } from './invites/invites.module';
import { RatingsModule } from './ratings/ratings.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SeriesModule } from './series/series.module';
import { TeamsModule } from './teams/teams.module';




@Module({
  imports: [
    // .env global
    ConfigModule.forRoot({ isGlobal: true }),

    // JWT (global)
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('JWT_SECRET') || 'dev_fallback',
        signOptions: { expiresIn: '12h' },
      }),
    }),

    // Redis
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

    // App modülleri
    PrismaModule,
    UsersModule,
    AuthModule,
    MatchesModule,
    MessagesModule,
    FriendsModule,
    InvitesModule,
    RatingsModule,
    NotificationsModule,
    SeriesModule,
    TeamsModule,
  ],
})
export class AppModule {}
