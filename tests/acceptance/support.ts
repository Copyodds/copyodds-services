import assert from 'node:assert/strict';
import pg from 'pg';

export const databaseUrl =
  process.env.ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://polycopy:polycopy@127.0.0.1:55432/polycopy_acceptance';

export function pool(max = 30): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max });
}

export async function expectPgError(
  action: () => Promise<unknown>,
  codes: string[],
  label: string,
): Promise<void> {
  try {
    await action();
    assert.fail(`${label}: expected PostgreSQL error ${codes.join('/')}`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    assert.ok(codes.includes(String(code)), `${label}: received PostgreSQL error ${code}`);
  }
}

export async function serializable<T>(
  db: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
  attempts = 5,
): Promise<{ value: T; retries: number }> {
  let retries = 0;
  for (;;) {
    const client = await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const value = await work(client);
      await client.query('COMMIT');
      return { value, retries };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string }).code === '40001' && retries < attempts - 1) {
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** retries));
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function percentile(samples: number[], p: number): number {
  assert.ok(samples.length > 0, 'percentile needs samples');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}
