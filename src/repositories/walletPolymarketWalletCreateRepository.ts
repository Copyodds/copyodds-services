import { prisma } from '../db';

export async function findWalletIdByPolymarketFunderAddress(
  depositAddress: string,
): Promise<number | null> {
  const deposit = depositAddress.trim();
  if (!deposit) return null;

  const wallet = await prisma.wallet.findFirst({
    where: {
      polymarketFunderAddress: { equals: deposit, mode: 'insensitive' },
    },
    select: { id: true },
  });
  return wallet?.id ?? null;
}

export async function getPolymarketWalletCreateRelayerTxIdByDeposit(
  depositAddress: string,
): Promise<string | null> {
  const deposit = depositAddress.trim();
  if (!deposit) return null;

  const wallet = await prisma.wallet.findFirst({
    where: {
      polymarketFunderAddress: { equals: deposit, mode: 'insensitive' },
    },
    select: { polymarketWalletCreateRelayerTxId: true },
  });
  const tid = (wallet?.polymarketWalletCreateRelayerTxId ?? '').trim();
  return tid || null;
}

export async function savePolymarketWalletCreateRelayerTxId(params: {
  depositAddress: string;
  relayerTransactionId: string;
}): Promise<{ walletId: number } | null> {
  const deposit = params.depositAddress.trim();
  const relayerTransactionId = params.relayerTransactionId.trim();
  if (!deposit || !relayerTransactionId) return null;

  const walletId = await findWalletIdByPolymarketFunderAddress(deposit);
  if (!walletId) return null;

  await prisma.wallet.update({
    where: { id: walletId },
    data: { polymarketWalletCreateRelayerTxId: relayerTransactionId },
  });
  return { walletId };
}
