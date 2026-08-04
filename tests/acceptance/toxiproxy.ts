import assert from 'node:assert/strict';

const api = process.env.TOXIPROXY_API ?? 'http://127.0.0.1:58474';

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Toxiproxy ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function createProxy(name: string, listen: string, upstream: string): Promise<void> {
  await request('/proxies', {
    method: 'POST',
    body: JSON.stringify({ name, listen, upstream, enabled: true }),
  });
}

async function toxic(
  proxy: string,
  name: string,
  type: string,
  attributes: Record<string, number>,
): Promise<void> {
  await request(`/proxies/${proxy}/toxics`, {
    method: 'POST',
    body: JSON.stringify({ name, type, stream: 'downstream', toxicity: 1, attributes }),
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'setup';
  if (mode === 'setup') {
    await createProxy('postgres', '0.0.0.0:15432', 'postgres:5432');
    await createProxy('nats', '0.0.0.0:14222', 'nats:4222');
    console.log('toxiproxy: postgres and nats proxies ready');
    return;
  }
  if (mode === 'clear') {
    for (const proxy of ['postgres', 'nats']) {
      const response = await request(`/proxies/${proxy}/toxics`);
      const rows = await response.json() as Array<{ name: string }>;
      await Promise.all(rows.map((row) =>
        request(`/proxies/${proxy}/toxics/${row.name}`, { method: 'DELETE' })));
    }
    console.log('toxiproxy: toxics cleared');
    return;
  }
  if (mode === 'db-timeout') {
    await toxic('postgres', 'db-timeout', 'timeout', { timeout: 250 });
    return;
  }
  if (mode === 'nats-timeout') {
    await toxic('nats', 'nats-timeout', 'timeout', { timeout: 250 });
    return;
  }
  if (mode === 'latency') {
    await toxic('postgres', 'db-latency', 'latency', { latency: 500, jitter: 100 });
    await toxic('nats', 'nats-latency', 'latency', { latency: 500, jitter: 100 });
    return;
  }
  assert.fail(`unknown toxiproxy mode: ${mode}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
