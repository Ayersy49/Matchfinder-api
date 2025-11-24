// src/elo/elo.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { EloService } from './elo.service';
import { PrismaService } from '../prisma/prisma.service';
import { IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/* ================== DTOs ================== */

class SubmitReportDto {
  @IsInt()
  @Min(0)
  @Max(99)
  @Type(() => Number)
  scoreTeamA!: number;

  @IsInt()
  @Min(0)
  @Max(99)
  @Type(() => Number)
  scoreTeamB!: number;

  @IsString()
  teamId!: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

class ResolveDisputeDto {
  @IsString()
  resolution!: 'AGREE_A' | 'AGREE_B' | 'INVALID';
}

/* ================== CONTROLLER ================== */

@Controller('elo')
export class EloController {
  constructor(
    private readonly elo: EloService,
    private readonly prisma: PrismaService
  ) {}

  /* ---------- MAÇ RAPORLAMA ---------- */

  /**
   * Maç sonucunu raporla
   * POST /elo/matches/:matchId/report
   */
  @Post('matches/:matchId/report')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  async submitReport(
    @Param('matchId') matchId: string,
    @Body() dto: SubmitReportDto,
    @Req() req: any
  ) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new BadRequestException('Kullanıcı bulunamadı');

    return this.elo.submitMatchReport(
      matchId,
      dto.teamId,
      userId,
      dto.scoreTeamA,
      dto.scoreTeamB,
      dto.notes
    );
  }

  /**
   * Maç raporlarını görüntüle
   * GET /elo/matches/:matchId/reports
   */
  @Get('matches/:matchId/reports')
  @UseGuards(AuthGuard('jwt'))
  async getMatchReports(@Param('matchId') matchId: string, @Req() req: any) {
    const userId = req.user?.id || req.user?.sub;

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        matchReports: {
          include: {
            team: { select: { id: true, name: true } },
            reporter: { select: { id: true, username: true, name: true } },
          },
        },
        teamA: { select: { id: true, name: true, elo: true } },
        teamB: { select: { id: true, name: true, elo: true } },
      },
    });

    if (!match) throw new BadRequestException('Maç bulunamadı');

    return {
      matchId: match.id,
      verificationStatus: match.verificationStatus,
      disputeDeadline: match.disputeDeadline,
      scoreTeamA: match.scoreTeamA,
      scoreTeamB: match.scoreTeamB,
      teamA: match.teamA,
      teamB: match.teamB,
      reports: match.matchReports.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        teamName: r.team.name,
        reporterName: r.reporter.name || r.reporter.username,
        scoreTeamA: r.scoreTeamA,
        scoreTeamB: r.scoreTeamB,
        notes: r.notes,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * Anlaşmazlığı çöz (Admin)
   * POST /elo/matches/:matchId/resolve-dispute
   */
  @Post('matches/:matchId/resolve-dispute')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  async resolveDispute(
    @Param('matchId') matchId: string,
    @Body() dto: ResolveDisputeDto,
    @Req() req: any
  ) {
    const userId = req.user?.id || req.user?.sub;

    // Kullanıcının maç sahibi veya takım kaptanı olduğunu kontrol et
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        teamA: { include: { members: { where: { role: { in: ['OWNER', 'ADMIN'] } } } } },
        teamB: { include: { members: { where: { role: { in: ['OWNER', 'ADMIN'] } } } } },
      },
    });

    if (!match) throw new BadRequestException('Maç bulunamadı');

    const isAdmin =
      match.ownerId === userId ||
      match.teamA?.members.some((m) => m.userId === userId) ||
      match.teamB?.members.some((m) => m.userId === userId);

    if (!isAdmin) {
      throw new BadRequestException('Bu işlem için yetkiniz yok');
    }

    return this.elo.resolveDispute(matchId, dto.resolution);
  }

  /* ---------- TAKIM ELO STATS ---------- */

  /**
   * Takımın Elo istatistiklerini al
   * GET /elo/teams/:teamId/stats
   */
  @Get('teams/:teamId/stats')
  async getTeamStats(@Param('teamId') teamId: string) {
    return this.elo.getTeamEloStats(teamId);
  }

  /**
   * Takımın maç geçmişini al (son 5 maç)
   * GET /elo/teams/:teamId/history
   */
  @Get('teams/:teamId/history')
  async getTeamHistory(
    @Param('teamId') teamId: string,
    @Query('limit') limit = '10'
  ) {
    const history = await this.prisma.teamEloHistory.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit, 10) || 10,
      include: {
        match: {
          select: {
            id: true,
            title: true,
            time: true,
            scoreTeamA: true,
            scoreTeamB: true,
            teamA: { select: { id: true, name: true } },
            teamB: { select: { id: true, name: true } },
          },
        },
      },
    });

    return {
      teamId,
      history: history.map((h) => ({
        matchId: h.matchId,
        matchTitle: h.match.title,
        matchTime: h.match.time,
        opponent:
          h.match.teamA?.id === teamId ? h.match.teamB?.name : h.match.teamA?.name,
        score: `${h.match.scoreTeamA ?? '?'} - ${h.match.scoreTeamB ?? '?'}`,
        eloDelta: h.delta,
        newElo: h.newElo,
        result: h.delta > 0 ? 'W' : h.delta < 0 ? 'L' : 'D',
        details: {
          teamRating: h.teamRating,
          opponentRating: h.opponentRating,
          expectedWinProb: h.expectedWinProb,
          tcf: h.tcf,
          streakFactor: h.streakFactor,
        },
        date: h.createdAt,
      })),
    };
  }

  /* ---------- SIRALAMA ---------- */

  /**
   * Elo sıralaması
   * GET /elo/leaderboard
   */
  @Get('leaderboard')
  async getLeaderboard(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0'
  ) {
    return this.elo.getEloLeaderboard(
      parseInt(limit, 10) || 50,
      parseInt(offset, 10) || 0
    );
  }

  /**
   * Takımın sırasını al
   * GET /elo/teams/:teamId/rank
   */
  @Get('teams/:teamId/rank')
  async getTeamRank(@Param('teamId') teamId: string) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { elo: true, matchCount: true },
    });

    if (!team) throw new BadRequestException('Takım bulunamadı');

    const rank = await this.prisma.team.count({
      where: {
        elo: { gt: team.elo },
        matchCount: { gte: 5 }, // Sadece provisional olmayan takımlar
      },
    });

    const total = await this.prisma.team.count({
      where: { matchCount: { gte: 5 } },
    });

    return {
      teamId,
      rank: rank + 1,
      total,
      elo: team.elo,
      isProvisional: team.matchCount < 5,
    };
  }

  /* ---------- REPUTATION (İTİBAR) ---------- */

  /**
   * Takımın itibar puanını al
   * GET /elo/teams/:teamId/reputation
   */
  @Get('teams/:teamId/reputation')
  @UseGuards(AuthGuard('jwt'))
  async getTeamReputation(@Param('teamId') teamId: string, @Req() req: any) {
    const userId = req.user?.id || req.user?.sub;

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        members: { where: { userId, role: { in: ['OWNER', 'ADMIN'] } } },
      },
    });

    if (!team) throw new BadRequestException('Takım bulunamadı');

    // İtibar puanı sadece takım yöneticilerine görünür
    const isAdmin = team.members.length > 0 || team.ownerId === userId;

    if (!isAdmin) {
      return {
        teamId,
        visible: false,
        message: 'İtibar puanı sadece takım yöneticilerine görünür',
      };
    }

    let warning: string | null = null;
    if (team.reputationScore <= 2.0) {
      warning = 'Dikkat: İtibar puanınız düşük. Lütfen maç sonuçlarını doğru bildirin.';
    }
    if (team.reputationScore <= 1.0) {
      warning = 'Uyarı: 72 saat boyunca sıralama maçı oluşturamazsınız.';
    }

    return {
      teamId,
      visible: true,
      reputationScore: team.reputationScore,
      maxScore: 5.0,
      minScore: 1.0,
      warning,
    };
  }
}
