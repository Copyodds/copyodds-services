import assert from 'node:assert/strict';
import pg from 'pg';
import { connect } from 'nats';

const api = process.env.TOXIPROXY_API ?? 'http://127.0.0.1:58474';
const proxyDatabaseUrl =
  process.env.ACCEPTANCE_PROXY_DATABASE_URL
  ?? 'postgresql://polycopy:polycopy@127.0.0.1:55433/polycopy_acceptance';
const proxyNatsUrl = process.env.ACCEPTANCE_PROXY_NATS_URL ?? 'nats://127.0.0.1:54223';

async function clear(proxy: string): Promise<void> {
  const response = await fetch(`${api}/proxies/${proxy}/toxics`);
  const rows = await response.json() as Array<{ name: string }>;
  await Promise.all(rows.map((row) =>
    fetch(`${api}/proxies/${proxy}/toxics/${row.name}`, { method: 'DELETE' })));
}

async function timeout(proxy: string): Promise<void> {
  const response = await fetch(`${api}/proxies/${proxy}/toxics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `${proxy}-acceptance-timeout`,
      type: 'timeout',
      stream: 'downstream',
      toxicity: 1,
      attributes: { timeout: 100 },
    }),
  });
  assert.ok(response.ok, `create ${proxy} timeout toxic`);
}

async function testDatabase(): Promise<void> {
  const client = new pg.Client({
    connectionString: proxyDatabaseUrl,
    connectionTimeoutMillis: 1_000,
    query_timeout: 1_000,
  });
  await client.connect();
  assert.equal((await client.query('SELECT 1 AS ok')).rows[0].ok, 1);
  await timeout('postgres');
  await assert.rejects(() => client.query('SELECT pg_sleep(2)'));
  await client.end().catch(() => undefined);
  await clear('postgres');
  const recovered = new pg.Client({ connectionString: proxyDatabaseUrl });
  await recovered.connect();
  assert.equal((await recovered.query('SELECT 1 AS ok')).rows[0].ok, 1);
  await recovered.end();
}

async function testNats(): Promise<void> {
  const first = await connect({ servers: proxyNatsUrl, timeout: 1_000 });
  await first.flush();
  await timeout('nats');
  await assert.rejects(() => connect({
    servers: proxyNatsUrl,
    timeout: 500,
    maxReconnectAttempts: 0,
  }));
  await first.close();
  await clear('nats');
  const recovered = await connect({ servers: proxyNatsUrl, timeout: 2_000 });
  await recovered.flush();
  await recovered.close();
}

async function main(): Promise<void> {
  await Promise.all([clear('postgres'), clear('nats')]);
  await testDatabase();
  await testNats();
  console.log('proxy.integration: DB and NATS timeout/recovery passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
