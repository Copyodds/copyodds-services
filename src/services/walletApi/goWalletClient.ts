import { getAddress } from 'viem';
import { CONFIG } from '../../config/env';
import { goWalletSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';
import { buildGoWalletHmacHeaders } from './goWalletHmac';

export type GoCreateWalletAddressRow = {
  network?: string;
  addr?: string;
  wallet_index?: number;
  WalletIndex?: number;
  derivation_scheme?: string;
};

export type GoCreateWalletResponse = {
  code?: number;
  data?: GoCreateWalletAddressRow[];
  message?: string;
  derivation_credential?: string;
};

export function isGoWalletCustodyConfigured(): boolean {
  return Boolean(
    CONFIG.goWalletServiceUrl?.trim() &&
      CONFIG.goWalletAppKey?.trim() &&
      CONFIG.goWalletAppToken?.trim()
  );
}

function baseUrl(): string {
  return (CONFIG.goWalletServiceUrl ?? '').replace(/\/+$/, '');
}

function normalizeTypedDataForGoSigner(typedData: Record<string, unknown>): Record<string, unknown> {
  const domain = typedData.domain;
  const typesUnknown = typedData.types;
  if (!domain || typeof domain !== 'object' || !typesUnknown || typeof typesUnknown !== 'object') {
    return typedData;
  }
  const types = typesUnknown as Record<string, Array<{ name: string; type: string }>>;
  if (types.EIP712Domain?.length) {
    return typedData;
  }
  const d = domain as Record<string, unknown>;
  const domainFieldOrder = ['name', 'version', 'chainId', 'verifyingContract', 'salt'] as const;
  const domainFieldTypes: Record<(typeof domainFieldOrder)[number], string> = {
    name: 'string',
    version: 'string',
    chainId: 'uint256',
    verifyingContract: 'address',
    salt: 'bytes32',
  };
  const eip712Domain: Array<{ name: string; type: string }> = [];
  for (const key of domainFieldOrder) {
    if (d[key] == null) continue;
    eip712Domain.push({ name: key, type: domainFieldTypes[key] });
  }
  if (eip712Domain.length === 0) {
    return typedData;
  }
  return {
    ...typedData,
    types: {
      ...types,
      EIP712Domain: eip712Domain,
    },
  };
}

function jsonStringifyForGo(body: unknown): string {
  return JSON.stringify(body ?? {}, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

export async function postGoWalletJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${baseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const bodyStr = jsonStringifyForGo(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-key': CONFIG.goWalletAppKey,
    ...buildGoWalletHmacHeaders({
      method: 'POST',
      path,
      bodyStr,
      appToken: CONFIG.goWalletAppToken,
    }),
  };
  const res = await safeFetch(url, { method: 'POST', headers, body: bodyStr }, goWalletSafeFetchOptions(baseUrl()));
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Go wallet API non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Go wallet API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return json as T;
}

export async function goCreateWallet(
  referCode: string,
  walletPassword: string
): Promise<{ polygonAddress: string; walletIndex: number }> {
  const raw = await postGoWalletJson<GoCreateWalletResponse>('/createWallet', {
    refer_code: referCode,
    wallet_password: walletPassword,
  });
  if (raw.code !== 0 && raw.code !== undefined) {
    throw new Error(raw.message ?? `createWallet failed code=${raw.code}`);
  }
  const rows = raw.data ?? [];
  const poly = rows.find(
    (r) => String(r.network ?? '').toLowerCase() === 'polygon' || String(r.network ?? '') === 'Polygon'
  );
  if (!poly?.addr) {
    throw new Error('createWallet: missing Polygon address in response');
  }
  const wi = poly.wallet_index ?? poly.WalletIndex;
  if (wi == null || typeof wi !== 'number') {
    throw new Error('createWallet: missing wallet_index in response');
  }
  return {
    polygonAddress: poly.addr,
    walletIndex: Number(wi),
  };
}

export type GoSignMessageResponse = { address?: string; signature?: string; code?: number; msg?: string };

export type GoSignTypedDataBody = {
  refer_code: string;
  walletIndex: number;
  wallet_password: string;
  typedData: Record<string, unknown>;
  /** Opaque, single-intent authorization issued by wallet-api after TOTP verification. */
  withdrawalAuthorization?: GoWithdrawalAuthorization;
};

export type GoWithdrawalAuthorization = {
  token: string;
  idempotencyKey: string;
};

export type GoSignTxBody = {
  refer_code: string;
  walletIndex: number;
  wallet_password: string;
  chainId: number;
  to: string;
  data: string;
  value?: string;
  nonce: number;
  gasLimit: number;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

export type GoSignTxResponse = {
  from?: string;
  rawTxHex?: string;
  hash?: string;
  code?: number;
  msg?: string;
};

export async function goSignMessage(
  referCode: string,
  walletIndex: number,
  walletPassword: string,
  message: string
): Promise<{ address: string; signature: string }> {
  const raw = await postGoWalletJson<GoSignMessageResponse>('/sign/message', {
    refer_code: referCode,
    walletIndex,
    wallet_password: walletPassword,
    message,
  });
  if (raw.code && raw.code !== 0) {
    const base = raw.msg ?? `sign message failed code=${raw.code}`;
    throw new Error(
      `${base} (refer_code=${referCode}, walletIndex=${walletIndex}, check Go wallet is rebuilt/restarted)`
    );
  }
  if (!raw.signature || !raw.address) {
    throw new Error('sign message: missing signature or address');
  }
  return { address: raw.address, signature: raw.signature };
}

const GO_WALLET_RESOLVE_POLYGON_ADDRESS_MESSAGE = 'polymarket-backend-resolve-polygon-address-v1';

export async function goResolvePolygonAddressForWallet(
  referCode: string,
  walletIndex: number,
  walletPassword: string,
): Promise<`0x${string}`> {
  const { address } = await goSignMessage(
    referCode,
    walletIndex,
    walletPassword,
    GO_WALLET_RESOLVE_POLYGON_ADDRESS_MESSAGE,
  );
  const trimmed = (address ?? '').trim();
  if (!trimmed.startsWith('0x')) {
    throw new Error('goResolvePolygonAddressForWallet: Go signer returned invalid address');
  }
  return getAddress(trimmed) as `0x${string}`;
}

export async function goSignTypedData(
  referCode: string,
  walletIndex: number,
  walletPassword: string,
  typedData: Record<string, unknown>,
  withdrawalAuthorization?: GoWithdrawalAuthorization,
): Promise<{ address: string; signature: string }> {
  const payload = normalizeTypedDataForGoSigner(typedData);
  const raw = await postGoWalletJson<GoSignMessageResponse>('/sign/typed-data', {
    refer_code: referCode,
    walletIndex,
    wallet_password: walletPassword,
    typedData: payload,
    ...(withdrawalAuthorization ? { withdrawalAuthorization } : {}),
  });
  if (raw.code && raw.code !== 0) {
    throw new Error(raw.msg ?? `sign typed-data failed code=${raw.code}`);
  }
  if (!raw.signature || !raw.address) {
    throw new Error('sign typed-data: missing signature or address');
  }
  return { address: raw.address, signature: raw.signature };
}

export type GoTreasuryPayoutResponse = {
  code?: number;
  msg?: string;
  message?: string;
  hash?: string;
  from?: string;
  to?: string;
  amount?: string;
  network?: string;
  nonce?: number;
};

/** Pay USDC.e from wallet-service treasury hot wallet to `to`. `amount` is base units (6 decimals). */
export async function goTreasuryPayoutUsdce(options: {
  to: string;
  amount: string;
}): Promise<{ hash: string; from: string; to: string; amount: string }> {
  const raw = await postGoWalletJson<GoTreasuryPayoutResponse>('/treasury/payout-usdce', {
    to: options.to,
    amount: options.amount,
  });
  if (raw.code != null && raw.code !== 0) {
    throw new Error(raw.msg ?? raw.message ?? `treasury payout failed code=${raw.code}`);
  }
  const hash = (raw.hash ?? '').trim();
  if (!hash.startsWith('0x')) {
    throw new Error('treasury payout: missing transaction hash');
  }
  return {
    hash,
    from: String(raw.from ?? ''),
    to: String(raw.to ?? options.to),
    amount: String(raw.amount ?? options.amount),
  };
}

export async function goSignTransaction(_body: GoSignTxBody): Promise<GoSignTxResponse> {
  throw new Error(
    'Go EOA transaction signing is disabled; use typed-data + Builder Relayer or the permit relayer',
  );
}

export type GoTotpIdentity = {
  refer_code: string;
  walletIndex: number;
};

export type GoWithdrawIntent = GoTotpIdentity & {
  network: 'Polygon';
  depositWallet: string;
  asset: 'USDC.e';
  to: string;
  amount: string;
  idempotencyKey: string;
};

type GoApiEnvelope<T> = {
  code?: number;
  data?: T;
  message?: string;
  msg?: string;
} & Partial<T>;

function unwrapGoApi<T extends object>(operation: string, raw: GoApiEnvelope<T>): T {
  if (raw.code != null && raw.code !== 0) {
    throw new Error(raw.message ?? raw.msg ?? `${operation} failed code=${raw.code}`);
  }
  return (raw.data && typeof raw.data === 'object' ? raw.data : raw) as T;
}

export async function goTotpStatus(
  identity: GoTotpIdentity,
): Promise<{ totpEnabled: boolean }> {
  const raw = await postGoWalletJson<
    GoApiEnvelope<{ totpEnabled?: boolean; enabled?: boolean; status?: string }>
  >(
    '/withdrawal-authorizations/status',
    identity,
  );
  const data = unwrapGoApi('totp status', raw);
  const enabled =
    data.totpEnabled ??
    data.enabled ??
    (typeof data.status === 'string'
      ? ['enabled', 'active', 'configured'].includes(data.status.toLowerCase())
      : undefined);
  if (typeof enabled !== 'boolean') {
    throw new Error('totp status: missing enabled state');
  }
  return { totpEnabled: enabled };
}

export async function goTotpSetup(
  identity: GoTotpIdentity & { accountLabel: string; issuer: string },
): Promise<{ otpauthUrl: string; manualEntryKey: string; expiresIn: number }> {
  const raw = await postGoWalletJson<
    GoApiEnvelope<{
      otpauthUrl?: string;
      otpauth_url?: string;
      provisioningUri?: string;
      manualEntryKey?: string;
      manual_entry_key?: string;
      secret?: string;
      expiresIn?: number;
      expires_in?: number;
    }>
  >('/withdrawal-authorizations/setup', identity);
  const data = unwrapGoApi('totp setup', raw);
  const otpauthUrl = data.otpauthUrl ?? data.otpauth_url ?? data.provisioningUri;
  const manualEntryKey = data.manualEntryKey ?? data.manual_entry_key ?? data.secret;
  const expiresIn = data.expiresIn ?? data.expires_in;
  if (!otpauthUrl || !manualEntryKey || !Number.isFinite(expiresIn)) {
    throw new Error('totp setup: incomplete response');
  }
  return { otpauthUrl, manualEntryKey, expiresIn: Number(expiresIn) };
}

export async function goTotpConfirm(
  identity: GoTotpIdentity & { code: string },
): Promise<{ totpEnabled: boolean }> {
  const raw = await postGoWalletJson<GoApiEnvelope<{ totpEnabled?: boolean; enabled?: boolean }>>(
    '/withdrawal-authorizations/confirm',
    identity,
  );
  const data = unwrapGoApi('totp confirm', raw);
  return { totpEnabled: data.totpEnabled ?? data.enabled ?? true };
}

export async function goTotpVerifyWithdraw(
  intent: GoWithdrawIntent & { code: string },
): Promise<{ authorization: string; expiresIn?: number }> {
  const raw = await postGoWalletJson<
    GoApiEnvelope<{
      authorization?: string;
      token?: string;
      expiresIn?: number;
      expires_in?: number;
    }>
  >('/withdrawal-authorizations/verify', intent);
  const data = unwrapGoApi('totp verify', raw);
  const token = data.token ?? data.authorization;
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('totp verify: missing authorization');
  }
  const expiresIn = data.expiresIn ?? data.expires_in;
  return {
    authorization: token,
    ...(Number.isFinite(expiresIn) ? { expiresIn: Number(expiresIn) } : {}),
  };
}

export async function goTotpDisable(
  identity: GoTotpIdentity & { code: string },
): Promise<{ totpEnabled: boolean }> {
  const raw = await postGoWalletJson<GoApiEnvelope<{ totpEnabled?: boolean; enabled?: boolean }>>(
    '/withdrawal-authorizations/disable',
    identity,
  );
  const data = unwrapGoApi('totp disable', raw);
  return { totpEnabled: data.totpEnabled ?? data.enabled ?? false };
}
