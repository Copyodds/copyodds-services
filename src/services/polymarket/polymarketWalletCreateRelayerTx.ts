import {
  getPolymarketWalletCreateRelayerTxIdByDeposit,
  savePolymarketWalletCreateRelayerTxId,
} from '../../repositories/walletPolymarketWalletCreateRepository';

/**
 * WALLET-CREATE submit 成功后立即持久化 relayer transactionID。
 * 失败仅打日志，不中断 relayer 流程；wait 超时/失败后 ID 仍保留在库中。
 */
export async function persistPolymarketWalletCreateRelayerTxId(params: {
  depositAddress: string;
  relayerTransactionId: string;
}): Promise<void> {
  const deposit = params.depositAddress.trim();
  const relayerTransactionId = params.relayerTransactionId.trim();
  if (!deposit || !relayerTransactionId) {
    return;
  }

  try {
    const saved = await savePolymarketWalletCreateRelayerTxId({
      depositAddress: deposit,
      relayerTransactionId,
    });
    if (!saved) {
      console.warn('[polymarket-wallet-create-tx] wallet not found for deposit', { deposit });
      return;
    }
    console.info('[polymarket-wallet-create-tx] persisted', {
      deposit,
      walletId: saved.walletId,
      relayerTransactionId,
    });
  } catch (err) {
    console.warn('[polymarket-wallet-create-tx] persist failed', {
      deposit,
      relayerTransactionId,
      err,
    });
  }
}

export async function loadPolymarketWalletCreateRelayerTxId(
  depositAddress: string,
): Promise<string | null> {
  return getPolymarketWalletCreateRelayerTxIdByDeposit(depositAddress);
}
