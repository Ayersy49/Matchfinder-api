// src/matches/matches.module.ts
import { Module } from '@nestjs/common';
import { MatchesController } from './matches.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [MatchesController],
  // providers/exports gerek yok; PrismaModule zaten PrismaService’i export ediyor.
})
export class MatchesModule {}
