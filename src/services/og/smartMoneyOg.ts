import sharp from 'sharp';
import { prisma } from '../../db';

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

export type SmartMoneyOgPayload = {
  wallet: string;
  displayName: string;
  tier: string;
  score: string;
  winRate: string;
  profit: string;
  rank: string | null;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmtScore(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(1);
}

function fmtWinRate(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) <= 1) return `${(n * 100).toFixed(2)}%`;
  return `${n.toFixed(2)}%`;
}

function fmtProfit(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const body =
    abs >= 1000
      ? `${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`
      : abs.toFixed(abs >= 100 ? 0 : 2);
  if (n > 0) return `+$${body}`;
  if (n < 0) return `-$${body}`;
  return `$${body}`;
}

function fmtProfitPct(raw: unknown): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // totalReturn1y / externalTotalReturn may be fraction or percent
  const pct = Math.abs(n) <= 5 ? n * 100 : n;
  const sign = pct > 0 ? '+' : pct < 0 ? '' : '';
  return `${sign}${pct.toFixed(0)}%`;
}

export function normalizeOgWallet(raw: string): string | null {
  const wallet = raw.trim();
  if (!EVM_RE.test(wallet)) return null;
  return wallet.toLowerCase();
}

export async function loadSmartMoneyOgPayload(
  wallet: string
): Promise<SmartMoneyOgPayload | null> {
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: {
      wallet: true,
      displayName: true,
      tier: true,
      score: true,
      traderScore: true,
      externalWinRate: true,
      totalPnl: true,
      externalTotalReturn: true,
      totalReturn1y: true,
      rank: true,
    },
  });
  if (!row) return null;

  const profitPct =
    fmtProfitPct(row.externalTotalReturn) ?? fmtProfitPct(row.totalReturn1y);
  const profitUsd = fmtProfit(row.totalPnl);
  const profit = profitPct && profitPct !== '—%' ? profitPct : profitUsd;

  return {
    wallet: row.wallet,
    displayName: row.displayName?.trim() || `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
    tier: (row.tier ?? '—').toUpperCase(),
    score: fmtScore(row.traderScore ?? row.score),
    winRate: fmtWinRate(row.externalWinRate),
    profit,
    rank: row.rank != null ? `#${row.rank}` : null,
  };
}

function buildOgSvg(payload: SmartMoneyOgPayload): string {
  const tierLabel =
    payload.tier && payload.tier !== '—'
      ? `${escapeXml(payload.tier)}-Tier Smart Money`
      : 'Smart Money';
  const name = escapeXml(payload.displayName);
  const score = escapeXml(payload.score);
  const winRate = escapeXml(payload.winRate);
  const profit = escapeXml(payload.profit);
  const rank = payload.rank ? escapeXml(payload.rank) : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#161812"/>
      <stop offset="100%" stop-color="#0f110d"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#d8b56b" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#d8b56b" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="220" fill="url(#glow)"/>
  <rect x="48" y="48" width="1104" height="534" rx="28" fill="#181b15" stroke="rgba(216,181,107,0.28)" stroke-width="2"/>
  <text x="88" y="120" fill="#d8b56b" font-family="Segoe UI, Arial, sans-serif" font-size="36" font-weight="700">CopyOdds</text>
  <text x="88" y="190" fill="#f7f1e3" font-family="Segoe UI, Arial, sans-serif" font-size="54" font-weight="700">${tierLabel}</text>
  <text x="88" y="240" fill="#978b73" font-family="Segoe UI, Arial, sans-serif" font-size="28">${name}${rank ? `  ·  ${rank}` : ''}</text>

  <text x="88" y="340" fill="#6f6653" font-family="Segoe UI, Arial, sans-serif" font-size="24">Score</text>
  <text x="420" y="340" fill="#34d399" font-family="Segoe UI, Arial, sans-serif" font-size="44" font-weight="700">${score}</text>

  <text x="88" y="420" fill="#6f6653" font-family="Segoe UI, Arial, sans-serif" font-size="24">Win Rate</text>
  <text x="420" y="420" fill="#f7f1e3" font-family="Segoe UI, Arial, sans-serif" font-size="44" font-weight="700">${winRate}</text>

  <text x="88" y="500" fill="#6f6653" font-family="Segoe UI, Arial, sans-serif" font-size="24">Profit</text>
  <text x="420" y="500" fill="#d8b56b" font-family="Segoe UI, Arial, sans-serif" font-size="44" font-weight="700">${profit}</text>

  <text x="880" y="520" fill="#978b73" font-family="Segoe UI, Arial, sans-serif" font-size="26">copyodds.io</text>
</svg>`;
}

export async function renderSmartMoneyOgPng(
  payload: SmartMoneyOgPayload
): Promise<Buffer> {
  const svg = buildOgSvg(payload);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export function buildSmartMoneyOgHtml(options: {
  payload: SmartMoneyOgPayload;
  pageUrl: string;
  imageUrl: string;
  appUrl: string;
}): string {
  const { payload, pageUrl, imageUrl, appUrl } = options;
  const title = `${payload.tier !== '—' ? `${payload.tier}-Tier ` : ''}Smart Money · ${payload.displayName}`;
  const description = `Score ${payload.score} · Win Rate ${payload.winRate} · Profit ${payload.profit} · Tracked on CopyOdds`;
  const safeTitle = escapeXml(title);
  const safeDesc = escapeXml(description);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}" />
  <link rel="canonical" href="${escapeXml(appUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="CopyOdds" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:url" content="${escapeXml(pageUrl)}" />
  <meta property="og:image" content="${escapeXml(imageUrl)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${escapeXml(imageUrl)}" />
  <style>
    body{margin:0;font-family:system-ui,sans-serif;background:#11130f;color:#f7f1e3;display:grid;place-items:center;min-height:100vh}
    a{color:#d8b56b}
  </style>
</head>
<body>
  <p>Opening <a href="${escapeXml(appUrl)}">Smart Money profile</a>…</p>
</body>
</html>`;
}
