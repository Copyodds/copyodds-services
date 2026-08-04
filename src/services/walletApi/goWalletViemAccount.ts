import type { Address, Hex } from 'viem';
import { toAccount } from 'viem/accounts';
import {
  goSignMessage,
  goSignTypedData,
  goSignTransaction,
  type GoSignTxBody,
  type GoWithdrawalAuthorization,
} from './goWalletClient';

export function createGoWalletViemAccount(params: {
  referCode: string;
  walletIndex: number;
  walletPassword: string;
  address: Address;
  /** Scoped to this account instance; only forwarded to typed-data signing. */
  withdrawalAuthorization?: GoWithdrawalAuthorization;
}) {
  const {
    referCode,
    walletIndex,
    walletPassword,
    address,
    withdrawalAuthorization,
  } = params;
  return toAccount({
    address,
    async signMessage({ message }) {
      let text: string;
      if (typeof message === 'string') {
        text = message;
      } else if (typeof message === 'object' && message !== null && 'raw' in message) {
        const raw = (message as { raw: Hex }).raw;
        text = Buffer.from(raw.slice(2), 'hex').toString('utf8');
      } else {
        text = String(message);
      }
      const { signature } = await goSignMessage(
        referCode,
        walletIndex,
        walletPassword,
        text,
      );
      return signature as Hex;
    },
    async signTypedData(typedData) {
      const { signature } = await goSignTypedData(
        referCode,
        walletIndex,
        walletPassword,
        typedData as Record<string, unknown>,
        withdrawalAuthorization,
      );
      return signature as Hex;
    },
    async signTransaction(tx: any) {
      const chainId = Number(tx.chainId);
      if (!Number.isFinite(chainId)) {
        throw new Error('goWalletViemAccount.signTransaction: missing chainId');
      }
      const to = tx.to as string;
      const data = (tx.data ?? '0x') as Hex;
      const gasLimit = Number(tx.gas ?? tx.gasLimit);
      if (!Number.isFinite(gasLimit) || gasLimit <= 0) {
        throw new Error('goWalletViemAccount.signTransaction: missing gas');
      }
      const nonce = Number(tx.nonce);
      if (!Number.isFinite(nonce) || nonce < 0) {
        throw new Error('goWalletViemAccount.signTransaction: missing nonce');
      }
      const body: GoSignTxBody = {
        refer_code: referCode,
        walletIndex,
        wallet_password: walletPassword,
        chainId,
        to,
        data,
        nonce,
        gasLimit,
      };
      if (tx.value != null && BigInt(tx.value) !== 0n) {
        const v = typeof tx.value === 'bigint' ? tx.value : BigInt(tx.value);
        body.value = ('0x' + v.toString(16)) as string;
      }
      if (tx.maxFeePerGas != null) {
        body.maxFeePerGas =
          typeof tx.maxFeePerGas === 'bigint'
            ? ('0x' + tx.maxFeePerGas.toString(16)) as string
            : (String(tx.maxFeePerGas) as string);
        const tip = tx.maxPriorityFeePerGas ?? tx.maxFeePerGas;
        body.maxPriorityFeePerGas =
          typeof tip === 'bigint' ? (('0x' + tip.toString(16)) as string) : (String(tip) as string);
      } else if (tx.gasPrice != null) {
        const gp = typeof tx.gasPrice === 'bigint' ? tx.gasPrice : BigInt(tx.gasPrice);
        body.gasPrice = ('0x' + gp.toString(16)) as string;
      } else {
        throw new Error('goWalletViemAccount.signTransaction: need gasPrice or EIP-1559 fee fields');
      }
      const out = await goSignTransaction(body);
      if (out.code && out.code !== 0) {
        throw new Error(out.msg ?? `Go sign-transaction failed code=${out.code}`);
      }
      if (!out.rawTxHex) {
        throw new Error('Go sign-transaction: missing rawTxHex');
      }
      return out.rawTxHex as Hex;
    },
  });
}
