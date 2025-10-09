// src/matches/matches.module.ts
import { Module } from '@nestjs/common';
import { MatchesController } from './matches.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],            // <-- EKLENDİ
  controllers: [MatchesController],
  providers: [PrismaService],
})
export class MatchesModule {}
