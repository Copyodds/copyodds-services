import { NextFunction, Router, type Request, type Response } from 'express';
import { Code, fail } from '../utils/response';
import {
  buildSmartMoneyOgHtml,
  loadSmartMoneyOgPayload,
  normalizeOgWallet,
  renderSmartMoneyOgPng,
} from '../services/og/smartMoneyOg';

const router = Router();

function resolvePublicApiBase(req: {
  protocol: string;
  get: (name: string) => string | undefined;
}): string {
  const fromEnv = (process.env.PUBLIC_API_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:3000';
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0]!.trim();
  return `${proto}://${host}`;
}

function resolveAppBase(): string {
  return (
    (process.env.PUBLIC_APP_BASE_URL ?? '').trim().replace(/\/$/, '') ||
    'https://app.copyodds.io'
  );
}

/** Canonical public share host, e.g. https://api.copyodds.io → /@0x… */
function resolveShareHost(req: {
  protocol: string;
  get: (name: string) => string | undefined;
}): string {
  const fromEnv = (process.env.PUBLIC_OG_SHARE_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (fromEnv) {
    // Allow either host root or legacy …/api/og/smart — normalize to host root for /@ links.
    return fromEnv.replace(/\/api\/og\/smart\/?$/i, '');
  }
  return resolvePublicApiBase(req);
}

function canonicalShareUrls(
  req: { protocol: string; get: (name: string) => string | undefined },
  wallet: string
) {
  const host = resolveShareHost(req);
  const pageUrl = `${host}/@${wallet}`;
  const imageUrl = `${host}/@${wallet}/image.png`;
  const appUrl = `${resolveAppBase()}/@${wallet}`;
  return { pageUrl, imageUrl, appUrl };
}

async function handleOgImage(walletRaw: string, res: Response, next: NextFunction) {
  try {
    const wallet = normalizeOgWallet(walletRaw);
    if (!wallet) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid wallet', 400);
      return;
    }
    const payload = await loadSmartMoneyOgPayload(wallet);
    if (!payload) {
      fail(res, Code.NOT_FOUND, 'Smart money profile not found', 404);
      return;
    }
    const png = await renderSmartMoneyOgPng(payload);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.send(png);
  } catch (err) {
    next(err);
  }
}

async function handleOgPage(
  req: Request,
  walletRaw: string,
  res: Response,
  next: NextFunction
) {
  try {
    const wallet = normalizeOgWallet(walletRaw);
    if (!wallet) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid wallet', 400);
      return;
    }
    const payload = await loadSmartMoneyOgPayload(wallet);
    if (!payload) {
      fail(res, Code.NOT_FOUND, 'Smart money profile not found', 404);
      return;
    }

    const { pageUrl, imageUrl, appUrl } = canonicalShareUrls(req, wallet);
    const ua = String(req.get('user-agent') || '');
    const isShareBot =
      /Twitterbot|facebookexternalhit|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp/i.test(
        ua
      );

    // Humans go straight to the app profile; crawlers need HTML with OG tags.
    if (!isShareBot) {
      res.redirect(302, appUrl);
      return;
    }

    const html = buildSmartMoneyOgHtml({ payload, pageUrl, imageUrl, appUrl });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.status(200).send(html);
  } catch (err) {
    next(err);
  }
}

/** Canonical short links: /@0x… and /@0x…/image.png (mount at app root) */
export const ogAtWalletRouter = Router();

ogAtWalletRouter.get('/@:wallet/image.png', async (req, res, next) => {
  await handleOgImage(String(req.params.wallet ?? ''), res, next);
});

ogAtWalletRouter.get('/@:wallet', async (req, res, next) => {
  await handleOgPage(req, String(req.params.wallet ?? ''), res, next);
});

/** Legacy: /api/og/smart/:wallet */
router.get('/smart/:wallet/image.png', async (req, res, next) => {
  await handleOgImage(String(req.params.wallet ?? ''), res, next);
});

router.get('/smart/:wallet', async (req, res, next) => {
  await handleOgPage(req, String(req.params.wallet ?? ''), res, next);
});

export const ogSmartMoneyRouter = router;
export default router;
