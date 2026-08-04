/**
 * 从 systemd LoadCredential 注入的 CREDENTIALS_DIRECTORY 读取敏感项，覆盖 .env 中的同名变量。
 * 与 wallet/pkg/config/secrets.go 约定一致：目录下文件名 → 环境变量名。
 */
import fs from 'node:fs';
import path from 'node:path';

/** credential 文件名（CREDENTIALS_DIRECTORY 下）→ process.env 键 */
export const SYSTEMD_CREDENTIAL_ENV_MAP: Readonly<Record<string, string>> = {
  go_wallet_app_key: 'GO_WALLET_APP_KEY',
  go_wallet_app_token: 'GO_WALLET_APP_TOKEN',
  node_wallet_derivation_encryption_key: 'NODE_WALLET_DERIVATION_ENCRYPTION_KEY',
  /** 收款国库地址（0x…），非私钥；须与 Go security.treasury_address / withdraw 派生地址一致 */
  custody_treasury_address: 'CUSTODY_TREASURY_ADDRESS',
  /** 腾讯云 COS：密码表备份 PutObject（建议 CAM 仅写权限） */
  cos_secret_id: 'COS_SECRET_ID',
  cos_secret_key: 'COS_SECRET_KEY',
};

export function readCredentialFile(credentialsDir: string, fileBase: string): string | null {
  const p = path.join(credentialsDir, fileBase);
  try {
    const val = fs.readFileSync(p, 'utf8').trim();
    return val || null;
  } catch {
    return null;
  }
}

/** 将 CREDENTIALS_DIRECTORY 中的密钥写入 process.env（优先于 .env 中同名字段）。 */
export function applySystemdCredentials(): string[] {
  const dir = (process.env.CREDENTIALS_DIRECTORY ?? '').trim();
  if (!dir) {
    return [];
  }

  const applied: string[] = [];
  for (const [fileBase, envKey] of Object.entries(SYSTEMD_CREDENTIAL_ENV_MAP)) {
    const val = readCredentialFile(dir, fileBase);
    if (val) {
      process.env[envKey] = val;
      applied.push(envKey);
    }
  }

  if (applied.length > 0) {
    console.log(`[env] applied systemd credentials from ${dir}: ${applied.join(', ')}`);
  }

  return applied;
}
