import { prisma } from '../src/db';

async function main() {
  const row = await prisma.smartMoneyLeaderboardRow.findFirst({
    where: { rank: 1 },
    select: { wallet: true, scoreExplain: true },
  });
  const card = (row?.scoreExplain as any)?.traderProfile?.card;
  console.log(
    JSON.stringify({
      wallet: row?.wallet,
      reason0: card?.reasons?.[0] ?? null,
      hasFactorDup:
        typeof card?.reasons?.[0] === 'string' &&
        /能力得分|仿跟单得分|回撤健康得分/.test(card.reasons[0]),
      penaltyItems: Array.isArray(card?.penaltyItems) ? card.penaltyItems.length : -1,
      formula: card?.formula ?? null,
    })
  );

  const withPenalty = await prisma.smartMoneyLeaderboardRow.findFirst({
    where: { rank: 541 },
    select: { wallet: true, rank: true, scoreExplain: true },
  });
  const pcard = (withPenalty?.scoreExplain as any)?.traderProfile?.card;
  console.log(
    JSON.stringify({
      wallet: withPenalty?.wallet,
      rank: withPenalty?.rank,
      penalty: pcard?.penalty ?? null,
      penaltyItems: pcard?.penaltyItems ?? [],
      reason0: pcard?.reasons?.[0] ?? null,
    })
  );
}

main().finally(() => prisma.$disconnect());
