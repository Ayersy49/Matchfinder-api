// Matchfinder-api/src/matches/matches.module.ts

import { Module } from '@nestjs/common';
import { MatchesController } from './matches.controller';
// import { MatchesService } from './matches.service'; // ← YORUM SATIRI YAP
import { MatchProposalsController } from './match-proposals.controller';
import { MatchProposalsService } from './match-proposals.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [MatchesController, MatchProposalsController],
  providers: [
    // MatchesService, // ← KALDIRDIK
    MatchProposalsService,
  ],
  exports: [
    // MatchesService, // ← KALDIRDIK
    MatchProposalsService,
  ],
})
export class MatchesModule {}