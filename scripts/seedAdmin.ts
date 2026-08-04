import { generateSecret, generateURI } from 'otplib';
import bcrypt from 'bcrypt';
import { CONFIG } from '../src/config/env';
import { prisma } from '../src/db';
import { encryptTotpSecret, isTotpEncryptionConfigured } from '../src/utils/totpSecretCrypto';

const BCRYPT_ROUNDS = 10;

function envTruthy(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

async function main() {
  const email = process.env.ADMIN_SEED_EMAIL?.trim().toLowerCase() ?? '';
  const password = process.env.ADMIN_SEED_PASSWORD ?? '';
  const name = process.env.ADMIN_SEED_NAME?.trim() || 'Admin';
  const regenerateTotp = envTruthy('ADMIN_SEED_REGENERATE_TOTP');

  if (!email) {
    throw new Error('ADMIN_SEED_EMAIL is required');
  }

  if (!password) {
    throw new Error('ADMIN_SEED_PASSWORD is required');
  }

  if (!isTotpEncryptionConfigured()) {
    throw new Error('TOTP_SECRET_ENCRYPTION_KEY is required to provision admin 2FA');
  }

  const existing = await prisma.adminUser.findUnique({
    where: { email },
    select: { id: true, totpEnabledAt: true },
  });

  const shouldProvisionTotp = !existing || regenerateTotp;
  let totpPlain: { secret: string; otpauthUrl: string } | null = null;
  let totpData:
    | {
        totpSecretEncrypted: string;
        totpEnabledAt: Date;
        totpPendingSecretEncrypted: null;
        totpPendingCreatedAt: null;
      }
    | undefined;

  if (shouldProvisionTotp) {
    const secret = generateSecret();
    totpPlain = {
      secret,
      otpauthUrl: generateURI({
        issuer: CONFIG.totpIssuer,
        label: email,
        secret,
      }),
    };
    totpData = {
      totpSecretEncrypted: encryptTotpSecret(secret),
      totpEnabledAt: new Date(),
      totpPendingSecretEncrypted: null,
      totpPendingCreatedAt: null,
    };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: {
      passwordHash,
      name,
      status: 'ACTIVE',
      ...(totpData ?? {}),
    },
    create: {
      email,
      passwordHash,
      name,
      status: 'ACTIVE',
      ...(totpData ?? {}),
    },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      totpEnabledAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  console.log('[seed:admin] seeded admin user');
  console.log(JSON.stringify(admin, null, 2));

  if (totpPlain) {
    console.log('\n=== Authenticator 绑定信息（请手动添加到验证器 App）===');
    console.log(`issuer: ${CONFIG.totpIssuer}`);
    console.log(`account: ${email}`);
    console.log(`manualEntryKey: ${totpPlain.secret}`);
    console.log(`otpauthUrl: ${totpPlain.otpauthUrl}`);
    console.log('====================================================\n');
  } else if (existing?.totpEnabledAt) {
    console.log('[seed:admin] 已存在且保留原 2FA；如需重置请设置 ADMIN_SEED_REGENERATE_TOTP=1');
  } else {
    console.log('[seed:admin] 已存在但未绑定 2FA；请设置 ADMIN_SEED_REGENERATE_TOTP=1 生成密钥');
  }
}

main()
  .catch((error) => {
    console.error('[seed:admin] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
