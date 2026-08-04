import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';

/** Polymarket HTML 响应含超大 CSP 头；undici 默认 16KB 会 UND_ERR_HEADERS_OVERFLOW。 */
const SAFE_FETCH_DISPATCHER = new Agent({
  maxHeaderSize: 256 * 1024,
});

type UndiciRequestInit = RequestInit & {
  dispatcher?: Agent;
};

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export function isProdEnv(): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

/** 出站 HTTP 允许访问的公网 API 主机（精确或子域匹配） */
export const POLYMARKET_API_HOSTS = [
  'polymarket.com',
  'www.polymarket.com',
  'gamma-api.polymarket.com',
  'data-api.polymarket.com',
  'user-pnl-api.polymarket.com',
  'clob.polymarket.com',
  'relayer-v2.polymarket.com',
  'bridge.polymarket.com',
  'predicting.top',
  'narrative.agent.heisenberg.so',
] as const;

export type SafeFetchOptions = {
  allowedHosts: readonly string[];
  /** 非生产环境允许对白名单 host 使用 http: */
  allowHttpInDev?: boolean;
  /** 非生产环境额外允许 localhost / 127.0.0.1 */
  allowDevLocalhost?: boolean;
  /**
   * 运维配置的 Go wallet-api：允许 http:// 到本机或 RFC1918 内网字面量 IP（任意端口），含 production。
   * 仅用于 GO_WALLET_SERVICE_URL，不用于用户可控 URL。
   */
  allowLoopbackHttp?: boolean;
  /** 未设置时：https 仅 443；http（开发）仅 80 */
  allowedPorts?: readonly number[];
};

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** 仅字面量 IPv4；不信任 DNS 解析到内网（防 DNS rebinding）。 */
function isPrivateRfc1918Ipv4Literal(hostname: string): boolean {
  if (net.isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split('.').map((x) => Number(x));
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Go wallet 同机 / 分机内网 HTTP 信任主机（loopback 或 RFC1918 字面量）。 */
function isGoWalletTrustedHttpHost(hostname: string): boolean {
  return isLoopbackHostname(hostname) || isPrivateRfc1918Ipv4Literal(hostname);
}

function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map((x) => Number(x));
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length);
      if (net.isIP(mapped) === 4) return isBlockedIp(mapped);
    }
    return false;
  }
  return true;
}

function hostMatchesAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const entry of allowedHosts) {
    const allowed = entry.toLowerCase();
    if (host === allowed) return true;
    if (host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

async function resolveHostnameIps(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) {
    return [hostname];
  }
  try {
    const records = await lookup(hostname, { all: true });
    return records.map((r) => r.address);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SsrfBlockedError(`DNS lookup failed for ${hostname}: ${msg}`);
  }
}

async function assertResolvedIpsSafe(hostname: string): Promise<void> {
  const ips = await resolveHostnameIps(hostname);
  if (ips.length === 0) {
    throw new SsrfBlockedError(`No DNS records for ${hostname}`);
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new SsrfBlockedError(`Blocked DNS resolution: ${hostname} -> ${ip}`);
    }
  }
}

function effectiveAllowedHosts(opts: SafeFetchOptions): string[] {
  const hosts = [...opts.allowedHosts];
  if (opts.allowLoopbackHttp) {
    hosts.push('localhost', '127.0.0.1');
  } else if (opts.allowDevLocalhost && !isProdEnv()) {
    hosts.push('localhost', '127.0.0.1');
  }
  return hosts;
}

function assertPortAllowed(parsed: URL, opts: SafeFetchOptions): void {
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  const isInternalAllowed =
    Boolean(opts.allowLoopbackHttp) && isGoWalletTrustedHttpHost(hostname);
  const isDevLocal =
    !isProdEnv() &&
    Boolean(opts.allowDevLocalhost) &&
    isLoopbackHostname(hostname);
  if (isInternalAllowed || isDevLocal) {
    return;
  }
  const defaultPorts = parsed.protocol === 'https:' ? [443] : [80];
  const allowed = opts.allowedPorts ?? defaultPorts;
  if (!allowed.includes(port)) {
    throw new SsrfBlockedError(`Blocked port: ${port}`);
  }
}

/**
 * 校验出站 URL：协议、主机白名单、端口、私网/元数据 IP（含 DNS 解析结果）。
 */
export async function assertSafeOutboundUrl(url: string | URL, opts: SafeFetchOptions): Promise<void> {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const hostname = parsed.hostname.toLowerCase();
  const allowHttpInDev = opts.allowHttpInDev ?? false;
  const isProd = isProdEnv();

  const allowInternalHttp =
    Boolean(opts.allowLoopbackHttp) && isGoWalletTrustedHttpHost(hostname);

  if (parsed.protocol !== 'https:') {
    const httpOk =
      (allowHttpInDev && !isProd && parsed.protocol === 'http:') ||
      (allowInternalHttp && parsed.protocol === 'http:');
    if (!httpOk) {
      throw new SsrfBlockedError(`Blocked protocol: ${parsed.protocol}`);
    }
  }

  const allowedHosts = effectiveAllowedHosts(opts);
  if (allowInternalHttp && isPrivateRfc1918Ipv4Literal(hostname)) {
    // 内网字面量 IP：允许，不走公网白名单
  } else if (!hostMatchesAllowlist(hostname, allowedHosts)) {
    throw new SsrfBlockedError(`Blocked host: ${hostname}`);
  }

  assertPortAllowed(parsed, opts);
  if (!allowInternalHttp) {
    await assertResolvedIpsSafe(hostname);
  }
}

const SAFE_FETCH_MAX_REDIRECTS = 5;

export async function safeFetch(
  url: string | URL,
  init: RequestInit,
  opts: SafeFetchOptions
): Promise<Response> {
  let currentUrl = typeof url === 'string' ? url : url.toString();

  for (let hop = 0; hop <= SAFE_FETCH_MAX_REDIRECTS; hop += 1) {
    await assertSafeOutboundUrl(currentUrl, opts);
    const res = await fetch(currentUrl, {
      ...init,
      redirect: 'manual',
      dispatcher: SAFE_FETCH_DISPATCHER,
    } as UndiciRequestInit);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location || hop >= SAFE_FETCH_MAX_REDIRECTS) {
        throw new SsrfBlockedError(
          `Blocked HTTP redirect (${res.status})${location ? ` to ${location}` : ''}`
        );
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return res;
  }

  throw new SsrfBlockedError('Blocked HTTP redirect: too many hops');
}

export function polymarketApiSafeFetchOptions(hosts: readonly string[] = POLYMARKET_API_HOSTS): SafeFetchOptions {
  return { allowedHosts: hosts };
}

export function goWalletSafeFetchOptions(serviceUrl: string): SafeFetchOptions {
  const parsed = new URL(serviceUrl);
  const host = parsed.hostname.toLowerCase();
  return {
    allowedHosts: [parsed.hostname],
    allowHttpInDev: true,
    allowDevLocalhost: true,
    // 同机 loopback 或分机 RFC1918 字面量 IP
    allowLoopbackHttp: isGoWalletTrustedHttpHost(host),
  };
}

/**
 * 启动时校验运维配置的出站服务 URL（如 GO_WALLET_SERVICE_URL）。
 * GO_WALLET / settlement authorizer：允许 http://127.0.0.1|localhost 或 http://RFC1918 内网字面量。
 * 其它服务：生产须 HTTPS，禁止 localhost/私网/metadata IP。
 */
export async function validateOutboundServiceUrl(name: string, rawUrl: string): Promise<void> {
  const trimmed = rawUrl.trim();
  if (!trimmed) return;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SsrfBlockedError(`${name}: invalid URL`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = isLoopbackHostname(hostname);
  const isTrustedInternalHttp =
    name === 'GO_WALLET_SERVICE_URL' &&
    parsed.protocol === 'http:' &&
    isGoWalletTrustedHttpHost(hostname);

  if (isTrustedInternalHttp) {
    return;
  }

  const isProd = isProdEnv();
  if (isProd && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`${name}: production requires https:// (got ${parsed.protocol})`);
  }
  if (!isProd && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SsrfBlockedError(`${name}: only http:// or https:// allowed`);
  }

  if (isProd) {
    if (isLoopback) {
      throw new SsrfBlockedError(`${name}: localhost is not allowed in production`);
    }
    await assertResolvedIpsSafe(hostname);
    return;
  }

  if (isLoopback) {
    return;
  }

  if (parsed.protocol === 'http:') {
    throw new SsrfBlockedError(
      `${name}: http:// is only allowed for trusted internal services on loopback/RFC1918 IPs`,
    );
  }

  await assertResolvedIpsSafe(hostname);
}
