// Matchfinder-api/src/matches/match-proposals.controller.ts

import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MatchProposalsService } from './match-proposals.service';

// ✅ HELPER EKLE
function getUserId(req: any): string {
  const id = req?.user?.id || req?.user?.sub || req?.user?.userId;
  if (!id) throw new UnauthorizedException('User ID missing');
  return String(id);
}

@Controller('matches/:matchId/proposals')
@UseGuards(JwtAuthGuard)
export class MatchProposalsController {
  constructor(private readonly proposalsService: MatchProposalsService) {}

  @Post()
  async createProposal(
    @Param('matchId') matchId: string,
    @Req() req: any,
    @Body() dto: { proposedDate: string },
  ) {
    const userId = getUserId(req);  // ✅ DÜZELT
    return this.proposalsService.createProposal(matchId, userId, dto.proposedDate);
  }

  @Get()
  async listProposals(@Param('matchId') matchId: string, @Req() req: any) {
    const userId = getUserId(req);  // ✅ DÜZELT
    return this.proposalsService.listProposals(matchId, userId);
  }

  @Post(':proposalId/vote')
  async voteProposal(
    @Param('matchId') matchId: string,
    @Param('proposalId') proposalId: string,
    @Req() req: any,
    @Body() dto: { vote: 'ACCEPT' | 'REJECT' },
  ) {
    const userId = getUserId(req);  // ✅ DÜZELT
    return this.proposalsService.voteProposal(proposalId, userId, dto.vote);
  }

  @Delete(':proposalId')
  async deleteProposal(
    @Param('matchId') matchId: string,
    @Param('proposalId') proposalId: string,
    @Req() req: any,
  ) {
    const userId = getUserId(req);  // ✅ DÜZELT
    return this.proposalsService.deleteProposal(proposalId, userId);
  }
}