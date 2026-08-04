import { CONFIG } from '../config/env';
import { observeExternalRequest } from '../observability/virtualCopyMetrics';
import { CTF_CONTRACT_ADDRESS, publicClient } from '../services/polymarket/web3';
import { polymarketApiSafeFetchOptions, safeFetch } from '../utils/ssrfGuard';

const ctfResolutionAbi = [
  {
    inputs: [{ name: '', type: 'bytes32' }],
    name: 'payoutDenominator',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: '', type: 'bytes32' },
      { name: '', type: 'uint256' },
    ],
    name: 'payoutNumerators',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

type ClobMarketToken = {
  token_id?: string;
  tokenId?: string;
};

type ClobMarketDetails = {
  condition_id?: string;
  conditionId?: string;
  tokens?: ClobMarketToken[];
};

export type VirtualSettlementEvidence = {
  conditionId: `0x${string}`;
  outcomeIndex: number;
  denominator: string;
  numerator: string;
  blockNumber: string;
  observedAt: string;
  source: 'POLYGON_CTF';
};

export type AuthoritativeVirtualSettlement = {
  tokenId: string;
  payoutNumerator: bigint;
  payoutDenominator: bigint;
  evidence: VirtualSettlementEvidence;
};

export interface VirtualCopySettlementAdapter {
  resolve(tokenId: string): Promise<AuthoritativeVirtualSettlement | null>;
}

async function observePolygonRequest<T>(
  operation: string,
  request: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const value = await request();
    observeExternalRequest('polygon', operation, startedAt, 'success');
    return value;
  } catch (error) {
    observeExternalRequest('polygon', operation, startedAt, 'error');
    throw error;
  }
}

function normalizedConditionId(value: string | undefined): `0x${string}` | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^0x[0-9a-f]{64}$/.test(normalized)
    ? normalized as `0x${string}`
    : null;
}

async function fetchClobMarketForToken(tokenId: string): Promise<{
  conditionId: `0x${string}`;
  outcomeIndex: number;
} | null> {
  const base = CONFIG.clobHost.replace(/\/$/, '');
  const timeoutMs = CONFIG.virtualCopyMarketDataTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let startedAt = performance.now();
    const byTokenResponse = await safeFetch(
      `${base}/markets-by-token/${encodeURIComponent(tokenId)}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal },
      polymarketApiSafeFetchOptions(),
    );
    observeExternalRequest(
      'clob',
      'settlement_token_mapping',
      startedAt,
      byTokenResponse.ok ? 'success' : 'http_error',
    );
    if (!byTokenResponse.ok) return null;
    const byToken = await byTokenResponse.json() as ClobMarketDetails;
    const conditionId = normalizedConditionId(byToken.condition_id ?? byToken.conditionId);
    if (!conditionId) return null;

    startedAt = performance.now();
    const marketResponse = await safeFetch(
      `${base}/clob-markets/${encodeURIComponent(conditionId)}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal },
      polymarketApiSafeFetchOptions(),
    );
    observeExternalRequest(
      'clob',
      'settlement_market',
      startedAt,
      marketResponse.ok ? 'success' : 'http_error',
    );
    if (!marketResponse.ok) return null;
    const market = await marketResponse.json() as ClobMarketDetails;
    const marketConditionId = normalizedConditionId(market.condition_id ?? market.conditionId);
    if (marketConditionId && marketConditionId !== conditionId) return null;
    const tokens = Array.isArray(market.tokens) ? market.tokens : [];
    const matchingIndexes = tokens.flatMap((token, index) => {
      const candidate = String(token.token_id ?? token.tokenId ?? '').trim();
      return candidate === tokenId ? [index] : [];
    });
    if (matchingIndexes.length !== 1) return null;
    return { conditionId, outcomeIndex: matchingIndexes[0]! };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const polygonCtfSettlementAdapter: VirtualCopySettlementAdapter = {
  async resolve(tokenId) {
    const normalizedTokenId = tokenId.trim();
    if (!normalizedTokenId) return null;
    const mapping = await fetchClobMarketForToken(normalizedTokenId);
    if (!mapping) return null;

    const blockNumber = await observePolygonRequest(
      'block_number',
      () => publicClient.getBlockNumber(),
    );
    const denominator = await observePolygonRequest('payout_denominator', () => publicClient.readContract({
      address: CTF_CONTRACT_ADDRESS,
      abi: ctfResolutionAbi,
      functionName: 'payoutDenominator',
      args: [mapping.conditionId],
      blockNumber,
    }));
    if (denominator <= 0n) return null;
    const numerator = await observePolygonRequest('payout_numerator', () => publicClient.readContract({
      address: CTF_CONTRACT_ADDRESS,
      abi: ctfResolutionAbi,
      functionName: 'payoutNumerators',
      args: [mapping.conditionId, BigInt(mapping.outcomeIndex)],
      blockNumber,
    }));
    if (numerator < 0n || numerator > denominator) return null;
    const observedAt = new Date().toISOString();
    return {
      tokenId: normalizedTokenId,
      payoutNumerator: numerator,
      payoutDenominator: denominator,
      evidence: {
        conditionId: mapping.conditionId,
        outcomeIndex: mapping.outcomeIndex,
        denominator: denominator.toString(),
        numerator: numerator.toString(),
        blockNumber: blockNumber.toString(),
        observedAt,
        source: 'POLYGON_CTF',
      },
    };
  },
};

let settlementAdapter: VirtualCopySettlementAdapter = polygonCtfSettlementAdapter;

export function getVirtualCopySettlementAdapter(): VirtualCopySettlementAdapter {
  return settlementAdapter;
}

export function setVirtualCopySettlementAdapterForTests(
  adapter: VirtualCopySettlementAdapter | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Virtual settlement adapter replacement is test-only');
  }
  settlementAdapter = adapter ?? polygonCtfSettlementAdapter;
}
