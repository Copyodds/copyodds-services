-- AlterTable: add social/display fields to smart money cached leaderboard rows
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "joinedAtText" TEXT;
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "profileImage" TEXT;
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "xUsername" TEXT;
