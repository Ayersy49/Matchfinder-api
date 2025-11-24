// src/elo/elo.service.ts
import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ELO Sistemi Konfigürasyonu
 */
const ELO_CONFIG = {
  INITIAL_ELO: 500,
  PROVISIONAL_MATCH_LIMIT: 5,
  PROVISIONAL_K_FACTOR: 60,
  PROVISIONAL_WEIGHTING: 0.5,
  STANDARD_K_FACTOR: 40,
  MIN_PLAYERS_FOR_TEAM_RATING: 5,
  STREAK_MAX: 5,
  STREAK_BONUS: 0.05,
  LOSS_SHIELD_START: 5,
  LOSS_SHIELD_FACTOR: 0.1,
  LOSS_SHIELD_MIN: 0.5,
  DISPUTE_TIMEOUT_HOURS: 48,
  REPUTATION_INITIAL: 5.0,
  REPUTATION_MIN: 1.0,
  REPUTATION_DECREASE_ON_DISPUTE: 1.0,
};

/**
 * Maç sonucu türleri
 */
type MatchOutcome = 'WIN' | 'DRAW' | 'LOSS';

/**
 * Elo hesaplama detayları
 */
interface EloCalculationDetails {
  teamElo: number;
  opponentElo: number;
  teamRating: number;
  opponentRating: number;
  rif: number;
  adjustedElo: number;
  expectedWinProb: number;
  actualOutcome: number;
  tcf: number;
  streakFactor: number;
  kFactor: number;
  eloDelta: number;
  newElo: number;
}

@Injectable()
export class EloService {
  private readonly logger = new Logger(EloService.name);

  constructor(private readonly prisma: PrismaService) {}

  /* ================== TEMEL ELO HESAPLAMALARI ================== */

  /**
   * Takım Rating (TR) hesapla
   * Aktif oyuncuların son pozisyon bazlı rating ortalaması
   */
  async calculateTeamRating(teamId: string, matchId?: string): Promise<number> {
    // Takımdaki aktif üyeleri al
    const members = await this.prisma.teamMember.findMany({
      where: { teamId, status: 'ACTIVE' },
      include: {
        user: {
          include: {
            posRatingsReceived: {
              orderBy: { createdAt: 'desc' },
              take: 5, // Son 5 rating
            },
          },
        },
      },
    });

    if (members.length < ELO_CONFIG.MIN_PLAYERS_FOR_TEAM_RATING) {
      // Yeterli oyuncu yoksa varsayılan değer
      return 5.0;
    }

    let totalRating = 0;
    let playerCount = 0;

    for (const member of members) {
      const ratings = member.user.posRatingsReceived;
      if (ratings.length > 0) {
        // Oyuncunun ortalama pozisyon ratingleri
        const avgRating = ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
        totalRating += avgRating;
        playerCount++;
      } else {
        // Rating yoksa 5.0 varsayılan
        totalRating += 5.0;
        playerCount++;
      }
    }

    return playerCount > 0 ? totalRating / playerCount : 5.0;
  }

  /**
   * Rating Influence Factor (RIF) hesapla
   * RIF_A = TR_A / TR_B
   */
  calculateRIF(teamRating: number, opponentRating: number): number {
    // Sıfıra bölmeyi önle
    if (opponentRating <= 0) return 1.0;
    return teamRating / opponentRating;
  }

  /**
   * Adjusted Effective Elo (AE) hesapla
   * AE = TeamElo * RIF
   */
  calculateAdjustedElo(teamElo: number, rif: number): number {
    return teamElo * rif;
  }

  /**
   * Expected Win Probability (P) hesapla
   * P_A = 1 / (1 + 10^((AE_B - AE_A) / 400))
   */
  calculateExpectedWinProbability(adjustedEloA: number, adjustedEloB: number): number {
    const exponent = (adjustedEloB - adjustedEloA) / 400;
    return 1 / (1 + Math.pow(10, exponent));
  }

  /**
   * Team Consistency Factor (TCF) hesapla
   * Son 5 maçın 3'ünde de oynayan oyuncuların oranı
   */
  async calculateTCF(teamId: string): Promise<number> {
    // Son 5 maçı al
    const recentMatches = await this.prisma.match.findMany({
      where: {
        OR: [{ teamAId: teamId }, { teamBId: teamId }],
        verificationStatus: 'VERIFIED',
      },
      orderBy: { time: 'desc' },
      take: 5,
      include: {
        attendances: {
          where: { status: 'GOING' },
        },
      },
    });

    if (recentMatches.length < 3) {
      return 1.0; // Yeterli maç yoksa tam değer
    }

    // Tüm maçlardaki oyuncuları say
    const playerMatchCounts = new Map<string, number>();

    for (const match of recentMatches) {
      const playerIds = new Set<string>();
      match.attendances.forEach((a) => playerIds.add(a.userId));
      playerIds.forEach((id) => {
        playerMatchCounts.set(id, (playerMatchCounts.get(id) || 0) + 1);
      });
    }

    // En az 3 maçta oynayan oyuncu sayısı
    let consistentPlayers = 0;
    playerMatchCounts.forEach((count) => {
      if (count >= 3) consistentPlayers++;
    });

    // TCF = consistentPlayers / 5 (max 1.0)
    return Math.min(1.0, consistentPlayers / 5);
  }

  /**
   * Streak Factor hesapla
   * Win streak: alpha_w = 1 + 0.05 * min(win_streak, 5)
   * Loss streak: alpha_l = 1 + 0.05 * min(loss_streak, 5) * LossShieldFactor
   */
  calculateStreakFactor(winStreak: number, lossStreak: number): number {
    if (winStreak > 0) {
      // Galibiyet serisi - bonus
      return 1 + ELO_CONFIG.STREAK_BONUS * Math.min(winStreak, ELO_CONFIG.STREAK_MAX);
    } else if (lossStreak > 0) {
      // Mağlubiyet serisi - LossShield uygula
      const alpha_l = 1 + ELO_CONFIG.STREAK_BONUS * Math.min(lossStreak, ELO_CONFIG.STREAK_MAX);
      
      // Loss Shield: 5+ mağlubiyetten sonra koruma
      let lossShieldFactor = 1.0;
      if (lossStreak > ELO_CONFIG.LOSS_SHIELD_START) {
        lossShieldFactor = Math.max(
          ELO_CONFIG.LOSS_SHIELD_MIN,
          1 - ELO_CONFIG.LOSS_SHIELD_FACTOR * (lossStreak - ELO_CONFIG.LOSS_SHIELD_START)
        );
      }

      return alpha_l * lossShieldFactor;
    }

    return 1.0;
  }

  /**
   * K-Factor hesapla (provisional vs regular)
   */
  getKFactor(matchCount: number): number {
    if (matchCount < ELO_CONFIG.PROVISIONAL_MATCH_LIMIT) {
      return ELO_CONFIG.PROVISIONAL_K_FACTOR;
    }
    return ELO_CONFIG.STANDARD_K_FACTOR;
  }

  /**
   * Maç sonucunu sayıya çevir
   */
  getOutcomeValue(outcome: MatchOutcome): number {
    switch (outcome) {
      case 'WIN':
        return 1.0;
      case 'DRAW':
        return 0.5;
      case 'LOSS':
        return 0.0;
    }
  }

  /**
   * Elo delta hesapla
   * Delta_Elo = K * (S - P) * TCF * StreakFactor
   */
  calculateEloDelta(
    kFactor: number,
    actualOutcome: number,
    expectedWinProb: number,
    tcf: number,
    streakFactor: number
  ): number {
    return Math.round(kFactor * (actualOutcome - expectedWinProb) * tcf * streakFactor);
  }

  /* ================== MAÇ SONUCU İŞLEME ================== */

  /**
   * Maç sonucunu işle ve Elo güncelle
   */
  async processMatchResult(
    matchId: string,
    scoreTeamA: number,
    scoreTeamB: number
  ): Promise<{
    teamA: EloCalculationDetails;
    teamB: EloCalculationDetails;
  }> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        teamA: true,
        teamB: true,
      },
    });

    if (!match || !match.teamA || !match.teamB) {
      throw new BadRequestException('Maç veya takımlar bulunamadı');
    }

    const teamA = match.teamA;
    const teamB = match.teamB;

    // Sonucu belirle
    const outcomeA: MatchOutcome =
      scoreTeamA > scoreTeamB ? 'WIN' : scoreTeamA < scoreTeamB ? 'LOSS' : 'DRAW';
    const outcomeB: MatchOutcome =
      scoreTeamB > scoreTeamA ? 'WIN' : scoreTeamB < scoreTeamA ? 'LOSS' : 'DRAW';

    // Her iki takım için hesapla
    const calcA = await this.calculateEloChange(teamA, teamB, outcomeA);
    const calcB = await this.calculateEloChange(teamB, teamA, outcomeB);

    // Transaction ile güncelle
    await this.prisma.$transaction(async (tx) => {
      // Takım A güncelle
      await tx.team.update({
        where: { id: teamA.id },
        data: {
          elo: calcA.newElo,
          matchCount: { increment: 1 },
          winStreak: outcomeA === 'WIN' ? { increment: 1 } : 0,
          lossStreak: outcomeA === 'LOSS' ? { increment: 1 } : 0,
        },
      });

      // Takım B güncelle
      await tx.team.update({
        where: { id: teamB.id },
        data: {
          elo: calcB.newElo,
          matchCount: { increment: 1 },
          winStreak: outcomeB === 'WIN' ? { increment: 1 } : 0,
          lossStreak: outcomeB === 'LOSS' ? { increment: 1 } : 0,
        },
      });

      // Elo geçmişi kaydet - Takım A
      await tx.teamEloHistory.create({
        data: {
          teamId: teamA.id,
          matchId: matchId,
          delta: calcA.eloDelta,
          newElo: calcA.newElo,
          eloBeforeMatch: calcA.teamElo,
          teamRating: calcA.teamRating,
          opponentElo: calcA.opponentElo,
          opponentRating: calcA.opponentRating,
          expectedWinProb: calcA.expectedWinProb,
          actualOutcome: calcA.actualOutcome,
          tcf: calcA.tcf,
          streakFactor: calcA.streakFactor,
        },
      });

      // Elo geçmişi kaydet - Takım B
      await tx.teamEloHistory.create({
        data: {
          teamId: teamB.id,
          matchId: matchId,
          delta: calcB.eloDelta,
          newElo: calcB.newElo,
          eloBeforeMatch: calcB.teamElo,
          teamRating: calcB.teamRating,
          opponentElo: calcB.opponentElo,
          opponentRating: calcB.opponentRating,
          expectedWinProb: calcB.expectedWinProb,
          actualOutcome: calcB.actualOutcome,
          tcf: calcB.tcf,
          streakFactor: calcB.streakFactor,
        },
      });

      // Maç skorunu güncelle
      await tx.match.update({
        where: { id: matchId },
        data: {
          scoreTeamA,
          scoreTeamB,
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date(),
        },
      });
    });

    this.logger.log(
      `Match ${matchId} processed: TeamA ${teamA.name} ${calcA.eloDelta > 0 ? '+' : ''}${calcA.eloDelta} (${calcA.newElo}), ` +
        `TeamB ${teamB.name} ${calcB.eloDelta > 0 ? '+' : ''}${calcB.eloDelta} (${calcB.newElo})`
    );

    return { teamA: calcA, teamB: calcB };
  }

  /**
   * Tek bir takım için Elo değişimini hesapla
   */
  private async calculateEloChange(
    team: { id: string; elo: number; matchCount: number; winStreak: number; lossStreak: number },
    opponent: { id: string; elo: number },
    outcome: MatchOutcome
  ): Promise<EloCalculationDetails> {
    // Team Rating hesapla
    const teamRating = await this.calculateTeamRating(team.id);
    const opponentRating = await this.calculateTeamRating(opponent.id);

    // RIF hesapla
    const rif = this.calculateRIF(teamRating, opponentRating);

    // Adjusted Elo
    const adjustedElo = this.calculateAdjustedElo(team.elo, rif);
    const opponentAdjustedElo = this.calculateAdjustedElo(
      opponent.elo,
      this.calculateRIF(opponentRating, teamRating)
    );

    // Expected Win Probability
    const expectedWinProb = this.calculateExpectedWinProbability(adjustedElo, opponentAdjustedElo);

    // TCF
    const tcf = await this.calculateTCF(team.id);

    // Streak Factor
    const streakFactor = this.calculateStreakFactor(team.winStreak, team.lossStreak);

    // K-Factor
    const kFactor = this.getKFactor(team.matchCount);

    // Actual Outcome
    const actualOutcome = this.getOutcomeValue(outcome);

    // Elo Delta
    const eloDelta = this.calculateEloDelta(kFactor, actualOutcome, expectedWinProb, tcf, streakFactor);

    // New Elo (minimum 100)
    const newElo = Math.max(100, team.elo + eloDelta);

    return {
      teamElo: team.elo,
      opponentElo: opponent.elo,
      teamRating,
      opponentRating,
      rif,
      adjustedElo,
      expectedWinProb,
      actualOutcome,
      tcf,
      streakFactor,
      kFactor,
      eloDelta,
      newElo,
    };
  }

  /* ================== MAÇ RAPORLAMA ================== */

  /**
   * Maç raporu gönder
   */
  async submitMatchReport(
    matchId: string,
    teamId: string,
    reporterId: string,
    scoreTeamA: number,
    scoreTeamB: number,
    notes?: string
  ): Promise<{ status: string; message: string }> {
    // Kullanıcının takımda olduğunu ve rolünü kontrol et
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: reporterId } },
    });

    if (!member || member.status !== 'ACTIVE') {
      throw new ForbiddenException('Bu takımda aktif üye değilsiniz');
    }

    // Maçı kontrol et
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { matchReports: true },
    });

    if (!match) {
      throw new BadRequestException('Maç bulunamadı');
    }

    if (match.teamAId !== teamId && match.teamBId !== teamId) {
      throw new ForbiddenException('Bu takım bu maçta oynamadı');
    }

    // Takımın reputation puanını kontrol et
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (team && team.reputationScore <= 2.0) {
      this.logger.warn(`Team ${teamId} has low reputation (${team.reputationScore}). Showing warning.`);
      // Uyarı göster ama izin ver
    }

    if (team && team.reputationScore <= 1.0) {
      throw new ForbiddenException(
        'Takımınızın itibar puanı çok düşük. 72 saat boyunca sıralama maçı oluşturamazsınız.'
      );
    }

    // Zaten rapor gönderilmiş mi?
    const existingReport = match.matchReports.find((r) => r.teamId === teamId);
    if (existingReport) {
      throw new BadRequestException('Bu takım zaten rapor göndermiş');
    }

    // Raporu oluştur
    await this.prisma.matchReport.create({
      data: {
        matchId,
        teamId,
        reporterId,
        reporterRole: member.role,
        scoreTeamA,
        scoreTeamB,
        notes,
      },
    });

    // İki takım da rapor gönderdi mi kontrol et
    const allReports = await this.prisma.matchReport.findMany({
      where: { matchId },
    });

    if (allReports.length === 2) {
      // İki rapor da var - karşılaştır
      const reportA = allReports.find((r) => r.teamId === match.teamAId);
      const reportB = allReports.find((r) => r.teamId === match.teamBId);

      if (
        reportA &&
        reportB &&
        reportA.scoreTeamA === reportB.scoreTeamA &&
        reportA.scoreTeamB === reportB.scoreTeamB
      ) {
        // Raporlar uyuşuyor - Elo hesapla
        await this.processMatchResult(matchId, reportA.scoreTeamA, reportA.scoreTeamB);
        return { status: 'VERIFIED', message: 'Maç sonucu onaylandı ve Elo güncellendi' };
      } else {
        // Raporlar uyuşmuyor - dispute
        const deadline = new Date();
        deadline.setHours(deadline.getHours() + ELO_CONFIG.DISPUTE_TIMEOUT_HOURS);

        await this.prisma.match.update({
          where: { id: matchId },
          data: {
            verificationStatus: 'DISPUTED',
            disputeDeadline: deadline,
          },
        });

        return {
          status: 'DISPUTED',
          message: `Raporlar uyuşmuyor. ${ELO_CONFIG.DISPUTE_TIMEOUT_HOURS} saat içinde düzeltilmezse maç geçersiz sayılacak.`,
        };
      }
    }

    // Sadece bir rapor var - bekle
    await this.prisma.match.update({
      where: { id: matchId },
      data: { verificationStatus: 'PENDING' },
    });

    return { status: 'PENDING', message: 'Raporunuz alındı. Rakip takımın raporunu bekliyoruz.' };
  }

  /**
   * Dispute'u çöz (admin veya yeniden rapor)
   */
  async resolveDispute(
    matchId: string,
    resolution: 'AGREE_A' | 'AGREE_B' | 'INVALID'
  ): Promise<{ status: string }> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { matchReports: true, teamA: true, teamB: true },
    });

    if (!match || match.verificationStatus !== 'DISPUTED') {
      throw new BadRequestException('Geçerli bir anlaşmazlık bulunamadı');
    }

    if (resolution === 'INVALID') {
      // Maç geçersiz - her iki takımın da itibar puanını düşür
      await this.prisma.$transaction([
        this.prisma.match.update({
          where: { id: matchId },
          data: { verificationStatus: 'INVALID' },
        }),
        this.prisma.team.update({
          where: { id: match.teamAId! },
          data: {
            reputationScore: {
              decrement: ELO_CONFIG.REPUTATION_DECREASE_ON_DISPUTE,
            },
          },
        }),
        this.prisma.team.update({
          where: { id: match.teamBId! },
          data: {
            reputationScore: {
              decrement: ELO_CONFIG.REPUTATION_DECREASE_ON_DISPUTE,
            },
          },
        }),
      ]);

      // Reputation'ı minimum değere çek
      await this.prisma.team.updateMany({
        where: {
          id: { in: [match.teamAId!, match.teamBId!] },
          reputationScore: { lt: ELO_CONFIG.REPUTATION_MIN },
        },
        data: { reputationScore: ELO_CONFIG.REPUTATION_MIN },
      });

      return { status: 'INVALID' };
    }

    // Bir tarafın raporunu kabul et
    const reportA = match.matchReports.find((r) => r.teamId === match.teamAId);
    const reportB = match.matchReports.find((r) => r.teamId === match.teamBId);

    const acceptedReport = resolution === 'AGREE_A' ? reportA : reportB;
    if (!acceptedReport) {
      throw new BadRequestException('Rapor bulunamadı');
    }

    await this.processMatchResult(matchId, acceptedReport.scoreTeamA, acceptedReport.scoreTeamB);

    return { status: 'VERIFIED' };
  }

  /* ================== TAKIM STATS ================== */

  /**
   * Takımın Elo istatistiklerini al
   */
  async getTeamEloStats(teamId: string): Promise<{
    elo: number;
    reputationScore: number;
    matchCount: number;
    winStreak: number;
    lossStreak: number;
    isProvisional: boolean;
    recentHistory: { result: 'W' | 'L' | 'D'; eloDelta: number; date: string }[];
    rank?: number;
  }> {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        eloHistory: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { match: true },
        },
      },
    });

    if (!team) {
      throw new BadRequestException('Takım bulunamadı');
    }

    // Son 5 maç geçmişi
    const recentHistory = team.eloHistory.map((h) => {
      let result: 'W' | 'L' | 'D';
      if (h.delta > 0) result = 'W';
      else if (h.delta < 0) result = 'L';
      else result = 'D';

      return {
        result,
        eloDelta: h.delta,
        date: h.createdAt.toISOString(),
      };
    });

    // Rank hesapla
    const higherRankedTeams = await this.prisma.team.count({
      where: { elo: { gt: team.elo } },
    });

    return {
      elo: team.elo,
      reputationScore: team.reputationScore,
      matchCount: team.matchCount,
      winStreak: team.winStreak,
      lossStreak: team.lossStreak,
      isProvisional: team.matchCount < ELO_CONFIG.PROVISIONAL_MATCH_LIMIT,
      recentHistory,
      rank: higherRankedTeams + 1,
    };
  }

  /**
   * Elo sıralamasını al
   */
  async getEloLeaderboard(limit = 50, offset = 0): Promise<{
    teams: Array<{
      id: string;
      name: string;
      elo: number;
      matchCount: number;
      rank: number;
    }>;
    total: number;
  }> {
    const [teams, total] = await Promise.all([
      this.prisma.team.findMany({
        where: { matchCount: { gte: ELO_CONFIG.PROVISIONAL_MATCH_LIMIT } },
        orderBy: { elo: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          name: true,
          elo: true,
          matchCount: true,
        },
      }),
      this.prisma.team.count({
        where: { matchCount: { gte: ELO_CONFIG.PROVISIONAL_MATCH_LIMIT } },
      }),
    ]);

    return {
      teams: teams.map((t, i) => ({
        ...t,
        rank: offset + i + 1,
      })),
      total,
    };
  }
}
