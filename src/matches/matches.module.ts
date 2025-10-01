// src/matches/matches.module.ts
import { Module } from '@nestjs/common';
import { MatchesController } from './matches.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [MatchesController],
  providers: [PrismaService],
})
export class MatchesModule {}
