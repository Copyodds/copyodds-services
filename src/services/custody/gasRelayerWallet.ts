import { createWalletClient, http, type Account, type Address, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { CONFIG } from '../../config/env';
import { decryptSecretV2 } from '../../utils/secretV2Crypto';

const chain = { ...polygon, id: CONFIG.chainId || polygon.id };
const V2_PREFIX = 'v2:';

function normalizePrivateKey(raw: string): `0x${string}` {
  const t = raw.trim();
  const hex = t.startsWith('0x') ? t : `0x${t}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('relayer private key must be 32-byte hex');
  }
  return hex as `0x${string}`;
}

function resolveRelayerPrivateKeyHex(): `0x${string}` | null {
  const stored = (CONFIG.eoaForwardRelayerPrivateKey ?? '').trim();
  if (!stored) {
    return null;
  }
  if (stored.startsWith(V2_PREFIX)) {
    const pass = (CONFIG.eoaForwardRelayerPassword ?? '').trim();
    if (!pass) {
      throw new Error(
        'EOA_FORWARD_RELAYER_PRIVATE_KEY is v2 encrypted; set EOA_FORWARD_RELAYER_PASSWORD or WALLET_PASSWORD_GAS',
      );
    }
    return normalizePrivateKey(decryptSecretV2(stored, pass));
  }
  return normalizePrivateKey(stored);
}

export function isEoaForwardGasRelayerConfigured(): boolean {
  return Boolean((CONFIG.eoaForwardRelayerPrivateKey ?? '').trim());
}

function resolveRelayerAccount(): Account | null {
  try {
    const pk = resolveRelayerPrivateKeyHex();
    if (!pk) {
      return null;
    }
    return privateKeyToAccount(pk);
  } catch (e) {
    console.error('[gas-relayer] failed to resolve relayer account', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export function getEoaForwardRelayerAddress(): Address | null {
  return resolveRelayerAccount()?.address ?? null;
}

export function getEoaForwardGasRelayerAccount(): Account {
  const account = resolveRelayerAccount();
  if (!account) {
    throw new Error('EOA forward gas relayer is not configured');
  }
  return account;
}

let cachedWalletClient: WalletClient | null = null;
let cachedPrivateKey: `0x${string}` | null = null;

/** 平台 gas relayer：EOA→funder 的 permit+transferFrom 由该钱包付 POL。 */
export function getEoaForwardGasRelayerWalletClient(): WalletClient {
  const pk = resolveRelayerPrivateKeyHex();
  if (!pk) {
    throw new Error('EOA forward gas relayer is not configured');
  }
  if (!cachedWalletClient || cachedPrivateKey !== pk) {
    const account = privateKeyToAccount(pk);
    const rpc = (CONFIG.rpcUrl ?? '').trim() || polygon.rpcUrls.default.http[0];
    cachedPrivateKey = pk;
    cachedWalletClient = createWalletClient({
      account,
      chain,
      transport: http(rpc, { timeout: CONFIG.rpcHttpTimeoutMs }),
    });
  }
  return cachedWalletClient;
}
