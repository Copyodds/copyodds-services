import type { Logger } from 'pino';

declare global {
  namespace Express {
    interface Request {
      /** pino-http 注入的子 logger，含 reqId */
      log?: Logger;
      requestId?: string;
    }
  }
}

export {};
