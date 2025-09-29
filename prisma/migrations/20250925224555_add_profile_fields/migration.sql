-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "dominantFoot" TEXT NOT NULL DEFAULT 'N',
ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "positions" TEXT[];
