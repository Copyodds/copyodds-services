import { prisma } from '../src/db';

async function main() {
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true, rank: { not: null } },
    select: { wallet: true, rank: true, scoreExplain: true },
  });
  for (const row of rows) {
    const card = (row.scoreExplain as any)?.traderProfile?.card;
    const items = card?.penaltyItems || [];
    if (Number(card?.penalty || 0) > 0 && items.length) {
      console.log(
        JSON.stringify({
          wallet: row.wallet,
          rank: row.rank,
          penalty: card.penalty,
          item0: items[0],
          reason0: (card.reasons || [])[0] || null,
        })
      );
      return;
    }
  }
  console.log('none');
}

main().finally(() => prisma.$disconnect());
