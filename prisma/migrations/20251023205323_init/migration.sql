-- CreateTable
CREATE TABLE "MatchAccessRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" DATETIME,
    CONSTRAINT "MatchAccessRequest_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MatchAccessRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "matchId" TEXT,
    "data" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME
);

-- CreateTable
CREATE TABLE "MatchSeries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "format" TEXT NOT NULL DEFAULT '7v7',
    "price" INTEGER,
    "dayOfWeek" INTEGER NOT NULL,
    "timeHHmm" TEXT NOT NULL,
    "tz" TEXT NOT NULL DEFAULT 'Europe/Istanbul',
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME,
    "inviteOnly" BOOLEAN NOT NULL DEFAULT true,
    "reservesPerTeam" INTEGER NOT NULL DEFAULT 2,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MatchSeries_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SeriesMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seriesId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pos" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeriesMember_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "MatchSeries" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SeriesMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SeriesMembershipRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seriesId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" DATETIME,
    CONSTRAINT "SeriesMembershipRequest_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "MatchSeries" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SeriesMembershipRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MatchAttendance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MatchAttendance_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MatchAttendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Match" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "level" TEXT NOT NULL DEFAULT 'Orta',
    "format" TEXT NOT NULL DEFAULT '7v7',
    "price" INTEGER,
    "time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "slots" JSONB NOT NULL DEFAULT [],
    "ownerId" TEXT,
    "seriesId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" DATETIME,
    "inviteOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Match_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Match_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "MatchSeries" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Match" ("createdAt", "format", "id", "level", "location", "ownerId", "price", "slots", "time", "title", "updatedAt") SELECT "createdAt", "format", "id", "level", "location", "ownerId", "price", "slots", "time", "title", "updatedAt" FROM "Match";
DROP TABLE "Match";
ALTER TABLE "new_Match" RENAME TO "Match";
CREATE INDEX "Match_seriesId_idx" ON "Match"("seriesId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "MatchAccessRequest_matchId_idx" ON "MatchAccessRequest"("matchId");

-- CreateIndex
CREATE INDEX "MatchAccessRequest_requesterId_idx" ON "MatchAccessRequest"("requesterId");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_access_req" ON "MatchAccessRequest"("matchId", "requesterId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_type_idx" ON "Notification"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_type_matchId_key" ON "Notification"("userId", "type", "matchId");

-- CreateIndex
CREATE INDEX "SeriesMember_userId_idx" ON "SeriesMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SeriesMember_seriesId_userId_key" ON "SeriesMember"("seriesId", "userId");

-- CreateIndex
CREATE INDEX "SeriesMembershipRequest_seriesId_idx" ON "SeriesMembershipRequest"("seriesId");

-- CreateIndex
CREATE INDEX "SeriesMembershipRequest_requesterId_idx" ON "SeriesMembershipRequest"("requesterId");

-- CreateIndex
CREATE UNIQUE INDEX "SeriesMembershipRequest_seriesId_requesterId_key" ON "SeriesMembershipRequest"("seriesId", "requesterId");

-- CreateIndex
CREATE INDEX "MatchAttendance_userId_idx" ON "MatchAttendance"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchAttendance_matchId_userId_key" ON "MatchAttendance"("matchId", "userId");
