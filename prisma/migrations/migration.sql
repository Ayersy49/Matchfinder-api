-- Elo Rating System Migration
-- Add new fields to Team for Elo tracking and reputation

-- Team tablosuna yeni alanlar ekle
ALTER TABLE "Team" ADD COLUMN "reputationScore" REAL NOT NULL DEFAULT 5.0;
ALTER TABLE "Team" ADD COLUMN "winStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Team" ADD COLUMN "lossStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Team" ADD COLUMN "matchCount" INTEGER NOT NULL DEFAULT 0;

-- Match tablosuna skor ve doğrulama alanları ekle
ALTER TABLE "Match" ADD COLUMN "scoreTeamA" INTEGER;
ALTER TABLE "Match" ADD COLUMN "scoreTeamB" INTEGER;
ALTER TABLE "Match" ADD COLUMN "verificationStatus" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Match" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "Match" ADD COLUMN "disputeDeadline" DATETIME;

-- MatchReport tablosu oluştur (maç sonucu bildirimi için)
CREATE TABLE "MatchReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reporterRole" TEXT NOT NULL,
    "scoreTeamA" INTEGER NOT NULL,
    "scoreTeamB" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchReport_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MatchReport_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MatchReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Her takım sadece bir kez rapor gönderebilir
CREATE UNIQUE INDEX "MatchReport_matchId_teamId_key" ON "MatchReport"("matchId", "teamId");
CREATE INDEX "MatchReport_matchId_idx" ON "MatchReport"("matchId");
CREATE INDEX "MatchReport_teamId_idx" ON "MatchReport"("teamId");

-- TeamEloHistory'ye detay alanları ekle
ALTER TABLE "TeamEloHistory" ADD COLUMN "eloBeforeMatch" INTEGER;
ALTER TABLE "TeamEloHistory" ADD COLUMN "teamRating" REAL;
ALTER TABLE "TeamEloHistory" ADD COLUMN "opponentElo" INTEGER;
ALTER TABLE "TeamEloHistory" ADD COLUMN "opponentRating" REAL;
ALTER TABLE "TeamEloHistory" ADD COLUMN "expectedWinProb" REAL;
ALTER TABLE "TeamEloHistory" ADD COLUMN "actualOutcome" REAL;
ALTER TABLE "TeamEloHistory" ADD COLUMN "tcf" REAL;
ALTER TABLE "TeamEloHistory" ADD COLUMN "streakFactor" REAL;
