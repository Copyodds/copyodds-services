#!/usr/bin/env node
/**
 * Replay leader-signal for a specific tx by decoding OrderFilled logs from chain.
 * Usage: node --env-file=.env scripts/replay-leader-tx.js --tx=0x... [--dry-run]
 */
require('../dist/src/loadEnv');

const TX_ARG = process.argv.find((a) => a.startsWith('--tx='));
const DRY_RUN = process.argv.includes('--dry-run');
const txHash = TX_ARG?.slice('--tx='.length)?.trim().toLowerCase();

if (!txHash || !/^0x[a-f0-9]{64}$/.test(txHash)) {
  console.error('Usage: node --env-file=.env scripts/replay-leader-tx.js --tx=0x... [--dry-run]');
  process.exit(1);
}

const RPC_URL = process.env.POLYGON_RPC_URL || process.env.RPC_URL || '';
const INTERNAL_SECRET = process.env.COPY_INTERNAL_SECRET || '';
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:3000';

const EXCHANGES = new Set([
  '0xe111180000d2663c0091e4f400237545b87b996b',
  '0xe2222d279d744050d28e00520010520000310f59',
]);

const V1_TOPIC = '0xd0a08e8c4939387e939cce2b71e9e1c4c45f4c4b8b8b8b8b8b8b8b8b8b8b8b8';
const V2_TOPIC_PREFIX = '0xd543adfd';

async function rpc(method, params) {
  if (!RPC_URL) throw new Error('POLYGON_RPC_URL or RPC_URL required');
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'rpc error');
  return json.result;
}

function addrFromTopic(t) {
  return ('0x' + t.slice(-40)).toLowerCase();
}

function priceFromAmounts(usdcRaw, shareRaw) {
  if (usdcRaw <= 0n || shareRaw <= 0n) return '';
  const scale = 1_000_000n;
  const scaled = (usdcRaw * scale) / shareRaw;
  const whole = scaled / scale;
  const frac = scaled % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

function decodeV2Log(lg) {
  const maker = addrFromTopic(lg.topics[2]);
  const taker = addrFromTopic(lg.topics[3]);
  const data = Buffer.from(lg.data.slice(2), 'hex');
  const side = Number(BigInt('0x' + data.slice(0, 32).toString('hex')));
  const tokenId = BigInt('0x' + data.slice(32, 64).toString('hex')).toString();
  const mAmt = BigInt('0x' + data.slice(64, 96).toString('hex'));
  const tAmt = BigInt('0x' + data.slice(96, 128).toString('hex'));
  const tradeSide = side === 0 ? 'BUY' : 'SELL';
  const amount = side === 0 ? tAmt : mAmt;
  const price = priceFromAmounts(side === 0 ? mAmt : tAmt, amount);
  return { maker, taker, side: tradeSide, tokenId, amount: amount.toString(), price, logIndex: parseInt(lg.logIndex, 16) };
}

async function getWatchList() {
  const res = await fetch(`${BACKEND_URL}/api/internal/copy-trade/watch-list`, {
    headers: { 'X-Internal-Secret': INTERNAL_SECRET },
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`watch-list failed: ${JSON.stringify(json)}`);
  return new Set(json.data.addresses.map((a) => a.toLowerCase()));
}

async function postLeaderSignal(body) {
  const res = await fetch(`${BACKEND_URL}/api/internal/copy-trade/leader-signal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  const watch = await getWatchList();
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  const blockNumber = parseInt(receipt.blockNumber, 16);

  /** leader -> has maker leg in this tx */
  const makerLeaders = new Set();
  const decoded = [];

  for (const lg of receipt.logs) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (!t0.includes(V2_TOPIC_PREFIX.slice(2)) && !t0.startsWith('0xd0a08e8c')) continue;
    let fill;
    try {
      fill = decodeV2Log(lg);
    } catch {
      continue;
    }
    decoded.push(fill);
    if (watch.has(fill.maker)) makerLeaders.add(fill.maker);
  }

  const signals = [];
  for (const fill of decoded) {
    const candidates = [];
    if (watch.has(fill.maker)) candidates.push({ leader: fill.maker, matchedBy: 'maker' });
    if (watch.has(fill.taker) && !EXCHANGES.has(fill.taker)) {
      candidates.push({ leader: fill.taker, matchedBy: 'taker' });
    }
    for (const c of candidates) {
      if (c.matchedBy === 'taker' && makerLeaders.has(c.leader)) continue;
      let side = fill.side;
      if (c.matchedBy === 'taker') side = side === 'BUY' ? 'SELL' : 'BUY';
      if (!fill.price || !fill.amount) continue;
      signals.push({
        leaderAddress: c.leader,
        txHash,
        logIndex: fill.logIndex,
        side,
        tokenId: fill.tokenId,
        price: fill.price,
        amount: fill.amount,
        blockNumber,
        sourceFillCount: 1,
        signalSource: 'block_scan_replay',
        maker: fill.maker,
        taker: fill.taker,
      });
    }
  }

  console.log('[replay-leader-tx]', { txHash, blockNumber, signals: signals.length });
  for (const sig of signals) {
    console.log('  candidate', {
      logIndex: sig.logIndex,
      leader: sig.leaderAddress,
      side: sig.side,
      price: sig.price,
      tokenId: sig.tokenId.slice(0, 20) + '...',
    });
    if (DRY_RUN) continue;
    const result = await postLeaderSignal(sig);
    console.log('  result', result);
  }
}

main().catch((e) => {
  console.error('[replay-leader-tx] fatal', e);
  process.exit(1);
});
