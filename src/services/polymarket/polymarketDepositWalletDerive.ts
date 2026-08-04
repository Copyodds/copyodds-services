/**
 * 与 Polymarket builder-relayer-client `deriveDepositWallet` 一致：由 owner（托管执行地址）确定性推导 deposit wallet（POLY_1271 funder）。
 * 文档：https://docs.polymarket.com/trading/deposit-wallets
 */
import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  pad,
  toHex,
} from 'viem';
import { publicClient } from './web3';

/** Polygon 主网，与 @polymarket/builder-relayer-client ContractConfig POL 一致 */
const POLYGON_DEPOSIT_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07' as const;
const POLYGON_DEPOSIT_IMPLEMENTATION = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB' as const;
const POLYGON_DEPOSIT_BEACON = '0x7A18EDfe055488A3128f01F563e5B479D92ffc3a' as const;

/** Amoy，与 builder-relayer-client AMOY 一致 */
const AMOY_DEPOSIT_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07' as const;
const AMOY_DEPOSIT_IMPLEMENTATION = '0x50a88fE9a441cB4c9c2aD6A2207CE2795C7D7Fbd' as const;
const AMOY_DEPOSIT_BEACON = '0x50a88fE9a441cB4c9c2aD6A2207CE2795C7D7Fbd' as const;

const FACTORY_BEACON_SELECTOR = '0x49493a4d' as const;

const ERC1967_CONST1: Hex =
  '0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';
const ERC1967_CONST2: Hex =
  '0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076';
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

const BEACON_CONST1: Hex =
  '0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3';
const BEACON_CONST2: Hex =
  '0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c';
const BEACON_MIDDLE: Hex = '0x60195155f3363d3d373d3d363d602036600436635c60da';
const BEACON_PREFIX = 0x6100523d8160233d3973n;

function initCodeHashERC1967(implementation: Address, args: Hex): Hex {
  const n = BigInt((args.length - 2) / 2);
  const combined = ERC1967_PREFIX + (n << 56n);
  return keccak256(
    concat([
      toHex(combined, { size: 10 }),
      implementation,
      '0x6009',
      ERC1967_CONST2,
      ERC1967_CONST1,
      args,
    ]),
  );
}

function initCodeHashERC1967BeaconProxy(beacon: Address, args: Hex): Hex {
  const n = BigInt((args.length - 2) / 2);
  const combined = BEACON_PREFIX + (n << 56n);
  return keccak256(
    concat([
      toHex(combined, { size: 10 }),
      beacon,
      BEACON_MIDDLE,
      BEACON_CONST2,
      BEACON_CONST1,
      args,
    ]),
  );
}

function depositContracts(chainId: number): {
  factory: Address;
  implementation: Address;
  beacon: Address;
} | null {
  if (chainId === 137) {
    return {
      factory: POLYGON_DEPOSIT_FACTORY,
      implementation: POLYGON_DEPOSIT_IMPLEMENTATION,
      beacon: POLYGON_DEPOSIT_BEACON,
    };
  }
  if (chainId === 80002) {
    return {
      factory: AMOY_DEPOSIT_FACTORY,
      implementation: AMOY_DEPOSIT_IMPLEMENTATION,
      beacon: AMOY_DEPOSIT_BEACON,
    };
  }
  return null;
}

function buildCreate2Args(factory: Address, ownerHex: Hex): { args: Hex; salt: Hex } {
  const walletId = pad(ownerHex, { dir: 'left', size: 32 });
  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }],
    [factory, walletId],
  );
  const salt = keccak256(args);
  return { args, salt };
}

function deriveUupsDepositWalletAddress(owner: string, chainId: number): string {
  const cfg = depositContracts(chainId);
  if (!cfg) {
    throw new Error(`Polymarket deposit wallet derivation is not supported for chainId ${chainId}`);
  }
  const { factory, implementation } = cfg;
  const ownerHex = owner as Hex;
  const { args, salt } = buildCreate2Args(factory, ownerHex);
  const bytecodeHash = initCodeHashERC1967(implementation, args);
  return getCreate2Address({ from: factory, salt, bytecodeHash });
}

function deriveBeaconDepositWalletAddress(owner: string, chainId: number): string {
  const cfg = depositContracts(chainId);
  if (!cfg) {
    throw new Error(`Polymarket deposit wallet derivation is not supported for chainId ${chainId}`);
  }
  const { factory, beacon } = cfg;
  const ownerHex = owner as Hex;
  const { args, salt } = buildCreate2Args(factory, ownerHex);
  const bytecodeHash = initCodeHashERC1967BeaconProxy(beacon, args);
  return getCreate2Address({ from: factory, salt, bytecodeHash });
}

async function readFactoryBeaconAddress(factory: Address): Promise<Address | null> {
  try {
    const raw = await publicClient.call({
      to: factory,
      data: FACTORY_BEACON_SELECTOR,
    });
    const hex = (raw.data ?? '0x').trim();
    if (!hex || hex === '0x' || hex.length < 66) {
      return null;
    }
    const addr = (`0x${hex.slice(-40)}` as Address);
    if (addr === '0x0000000000000000000000000000000000000000') {
      return null;
    }
    return addr;
  } catch {
    return null;
  }
}

/**
 * RelayClient `deriveDepositWalletAddress` 返回的 UUPS counterfactual（与链上 Beacon 部署地址可能不同）。
 */
export function deriveRelayerDepositWalletAddress(owner: string, chainId: number): string {
  return deriveUupsDepositWalletAddress(owner, chainId);
}

/**
 * 活跃 funder：已部署 UUPS 则用 UUPS，否则 BeaconProxy（与 Polymarket WALLET-CREATE 链上部署一致）。
 * 写入 `polymarketFunderAddress`、CLOB funder、余额/授权均须用此地址。
 */
export async function resolvePolymarketDepositWalletAddress(owner: string, chainId: number): Promise<string> {
  const cfg = depositContracts(chainId);
  if (!cfg) {
    throw new Error(`Polymarket deposit wallet derivation is not supported for chainId ${chainId}`);
  }
  const uupsWallet = deriveUupsDepositWalletAddress(owner, chainId) as Address;
  const beaconOnFactory = await readFactoryBeaconAddress(cfg.factory);
  if (!beaconOnFactory) {
    return uupsWallet;
  }
  const uupsCode = await publicClient.getBytecode({ address: uupsWallet });
  if (uupsCode && uupsCode !== '0x') {
    return uupsWallet;
  }
  return deriveBeaconDepositWalletAddress(owner, chainId);
}

/** @deprecated 请用 deriveRelayerDepositWalletAddress */
export function derivePolymarketDepositWalletAddress(owner: string, chainId: number): string {
  return deriveRelayerDepositWalletAddress(owner, chainId);
}

/** DB 是否误写了 UUPS，而 resolve 已指向 Beacon（含 WALLET-CREATE 已上链 Beacon 的情况）。 */
export async function shouldCorrectStoredDepositFunderMisassignedUups(params: {
  ownerAddress: string;
  chainId: number;
  storedDeposit: string;
}): Promise<boolean> {
  const uups = deriveRelayerDepositWalletAddress(params.ownerAddress, params.chainId);
  if (uups.toLowerCase() !== params.storedDeposit.toLowerCase()) {
    return false;
  }
  const resolved = await resolvePolymarketDepositWalletAddress(params.ownerAddress, params.chainId);
  return resolved.toLowerCase() !== uups.toLowerCase();
}

/** @deprecated 旧逻辑方向相反，请用 shouldCorrectStoredDepositFunderMisassignedUups */
export async function shouldCorrectStoredDepositFunderToRelayer(params: {
  ownerAddress: string;
  chainId: number;
  storedDeposit: string;
}): Promise<boolean> {
  return shouldCorrectStoredDepositFunderMisassignedUups(params);
}

export function describeDepositWalletDerivation(owner: string, chainId: number): {
  relayerUups: string;
  beaconProxy: string;
} {
  return {
    relayerUups: deriveRelayerDepositWalletAddress(owner, chainId),
    beaconProxy: deriveBeaconDepositWalletAddress(owner, chainId),
  };
}
