import { ethers } from 'ethers';
import { goSignMessage, goSignTypedData, goSignTransaction, type GoSignTxBody } from './goWalletClient';

function inferEip712PrimaryType(types: Record<string, Array<{ name: string; type: string }>>): string {
  let fromEncoder = '';
  try {
    fromEncoder = ethers.utils._TypedDataEncoder.from(types).primaryType;
  } catch {
    fromEncoder = '';
  }
  if (fromEncoder && types[fromEncoder]?.length) {
    return fromEncoder;
  }
  const keys = Object.keys(types).filter((k) => k !== 'EIP712Domain');
  const withFields = keys.filter((k) => (types[k]?.length ?? 0) > 0);
  if (withFields.length === 1) {
    return withFields[0]!;
  }
  if (fromEncoder && withFields.includes(fromEncoder)) {
    return fromEncoder;
  }
  if (withFields.length > 0) {
    return withFields[0]!;
  }
  throw new Error('GoRemoteEthersSigner: cannot infer EIP-712 primaryType from types');
}

export class GoRemoteEthersSigner extends ethers.Signer {
  readonly goAddress: string;

  constructor(
    readonly referCode: string,
    readonly walletIndex: number,
    readonly walletPassword: string,
    addressInput: string,
    provider?: ethers.providers.Provider
  ) {
    super();
    this.goAddress = ethers.utils.getAddress(addressInput);
    ethers.utils.defineReadOnly(this as any, 'provider', provider ?? null);
  }

  connect(provider: ethers.providers.Provider): GoRemoteEthersSigner {
    return new GoRemoteEthersSigner(
      this.referCode,
      this.walletIndex,
      this.walletPassword,
      this.goAddress,
      provider,
    );
  }

  async getAddress(): Promise<string> {
    return this.goAddress;
  }

  async signMessage(message: string | ethers.Bytes): Promise<string> {
    const asString =
      typeof message === 'string' ? message : ethers.utils.toUtf8String(ethers.utils.arrayify(message));
    const { signature } = await goSignMessage(
      this.referCode,
      this.walletIndex,
      this.walletPassword,
      asString,
    );
    return signature;
  }

  async signTransaction(transaction: ethers.providers.TransactionRequest): Promise<string> {
    const prov = this.provider;
    if (!prov) {
      throw new Error('GoRemoteEthersSigner.signTransaction requires a provider (nonce/chainId/gas)');
    }
    const tx = await ethers.utils.resolveProperties(transaction);
    const net = await prov.getNetwork();
    const chainId = tx.chainId != null ? ethers.BigNumber.from(tx.chainId).toNumber() : net.chainId;
    const from = await this.getAddress();
    const nonce =
      tx.nonce != null
        ? ethers.BigNumber.from(tx.nonce).toNumber()
        : await prov.getTransactionCount(from, 'pending');
    if (!tx.to) {
      throw new Error('GoRemoteEthersSigner.signTransaction: missing `to`');
    }
    const to = ethers.utils.getAddress(tx.to);
    const data = ethers.utils.hexlify(tx.data ?? '0x');
    const gasLimit = ethers.BigNumber.from(tx.gasLimit ?? (tx as any).gas).toNumber();
    if (!Number.isFinite(gasLimit) || gasLimit <= 0) {
      throw new Error('GoRemoteEthersSigner.signTransaction: invalid gasLimit');
    }

    const body: GoSignTxBody = {
      refer_code: this.referCode,
      walletIndex: this.walletIndex,
      wallet_password: this.walletPassword,
      chainId,
      to,
      data,
      nonce,
      gasLimit,
    };
    if (tx.value != null && !ethers.BigNumber.from(tx.value).isZero()) {
      body.value = ethers.utils.hexValue(tx.value);
    }
    if (tx.maxFeePerGas != null) {
      body.maxFeePerGas = ethers.utils.hexValue(tx.maxFeePerGas);
      body.maxPriorityFeePerGas = ethers.utils.hexValue(
        tx.maxPriorityFeePerGas ?? tx.maxFeePerGas
      );
    } else {
      const gp = tx.gasPrice ?? (await prov.getGasPrice());
      body.gasPrice = ethers.utils.hexValue(gp);
    }

    const out = await goSignTransaction(body);
    if (out.code && out.code !== 0) {
      throw new Error(out.msg ?? `Go sign-transaction failed code=${out.code}`);
    }
    if (!out.rawTxHex) {
      throw new Error('Go sign-transaction: missing rawTxHex');
    }
    return out.rawTxHex;
  }

  async _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, any>
  ): Promise<string> {
    const primaryType = inferEip712PrimaryType(types);
    const typedData = {
      domain,
      types,
      primaryType,
      message: value,
    };
    const { signature } = await goSignTypedData(
      this.referCode,
      this.walletIndex,
      this.walletPassword,
      typedData as Record<string, unknown>,
    );
    return signature;
  }
}
