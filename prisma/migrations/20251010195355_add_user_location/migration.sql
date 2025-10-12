-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phone" TEXT NOT NULL,
    "dominantFoot" TEXT NOT NULL DEFAULT 'N',
    "positions" JSONB NOT NULL,
    "positionLevels" JSONB,
    "availability" JSONB,
    "preferredFormation" TEXT,
    "level" INTEGER NOT NULL DEFAULT 5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lat" REAL,
    "lng" REAL,
    "discoverable" BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO "new_User" ("availability", "createdAt", "dominantFoot", "id", "level", "phone", "positionLevels", "positions", "preferredFormation", "updatedAt") SELECT "availability", "createdAt", "dominantFoot", "id", "level", "phone", "positionLevels", "positions", "preferredFormation", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
CREATE INDEX "User_lat_lng_idx" ON "User"("lat", "lng");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
