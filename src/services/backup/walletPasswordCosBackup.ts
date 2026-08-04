import COS from 'cos-nodejs-sdk-v5';
import { CONFIG } from '../../config/env';

export type WalletPasswordBackupRow = {
  referCode: string;
  userId: number;
  cipher: string;
  scheme: string;
  version: number;
};

function isCosBackupReady(): boolean {
  return (
    CONFIG.walletPasswordCosBackupEnabled &&
    Boolean(CONFIG.cosSecretId) &&
    Boolean(CONFIG.cosSecretKey) &&
    Boolean(CONFIG.cosBucket) &&
    Boolean(CONFIG.cosRegion)
  );
}

function objectKey(referCode: string): string {
  const prefix = CONFIG.cosWalletPasswordPrefix.replace(/^\/+|\/+$/g, '');
  const safe = referCode.trim();
  return prefix ? `${prefix}/${safe}.json` : `${safe}.json`;
}

async function putWalletPasswordBackup(row: WalletPasswordBackupRow): Promise<void> {
  if (!isCosBackupReady()) return;
  const referCode = row.referCode.trim();
  if (!referCode || !row.cipher) return;

  const body = JSON.stringify({
    referCode,
    userId: row.userId,
    cipher: row.cipher,
    scheme: row.scheme,
    version: row.version,
  });

  const cos = new COS({
    SecretId: CONFIG.cosSecretId,
    SecretKey: CONFIG.cosSecretKey,
  });

  await new Promise<void>((resolve, reject) => {
    cos.putObject(
      {
        Bucket: CONFIG.cosBucket,
        Region: CONFIG.cosRegion,
        Key: objectKey(referCode),
        Body: Buffer.from(body, 'utf8'),
        ContentType: 'application/json; charset=utf-8',
      },
      (err, _data) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

/** Fire-and-forget; never throws. Logs only on failure (for daily journalctl grep). */
export function scheduleWalletPasswordCosBackup(row: WalletPasswordBackupRow): void {
  if (!isCosBackupReady()) return;
  void putWalletPasswordBackup(row).catch((err: unknown) => {
    const e = err as {
      code?: string;
      message?: string;
      error?: { Code?: string; Message?: string };
    };
    console.error('[wallet-password-cos-backup] put failed', {
      referCode: row.referCode,
      userId: row.userId,
      code: e?.code ?? e?.error?.Code ?? 'unknown',
      message: String(e?.error?.Message ?? e?.message ?? err).slice(0, 300),
    });
  });
}
