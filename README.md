<div align="center">

**English** · [简体中文](README_CN.md) · [日本語](README_JA.md) · [한국어](README_KO.md) · [Português do Brasil](README_PT-BR.md)

# Polymarket Agent Backend

**Copy trading, smart-money discovery, and custodial wallet APIs for Polymarket.**

A production-grade Node.js backend that powers user auth, copy-trade execution, smart-money leaderboards, custodial deposits, and admin operations — built for Polymarket CLOB and on-chain settlement on Polygon.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Prisma-4169E1?logo=postgresql&logoColor=white)](https://www.prisma.io/)
[![Polymarket](https://img.shields.io/badge/Polymarket-CLOB-6366F1)](https://polymarket.com/)
[![Polygon](https://img.shields.io/badge/Polygon-137-8247E5?logo=polygon&logoColor=white)](https://polygon.technology/)

</div>

---

## Features

| Module | Description |
|--------|-------------|
| **Copy Trading** | Subscribe to leaders, auto-dispatch orders, retry & funding checks, PnL ledger |
| **Smart Money** | Leaderboard scoring, trader profiles, copy-pool gating, on-demand analysis |
| **Custodial Wallet** | EOA deposit forwarding, Polymarket deposit, Go wallet remote signing |
| **Virtual Copy** | Paper-trading simulation with order-book fill and settlement |
| **Auth & Security** | JWT sessions, Passkey, TOTP step-up, SSRF guards, internal secret routes |
| **Admin** | Dashboard cron, risk controls, affiliate tiers, gas packages |

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, API_KEY, RPC_URL, etc.

# 3. Generate Prisma client & run migrations
npx prisma migrate dev

# 4. Start dev server (hot reload)
npm run dev
```

Default API listens on `http://localhost:3000` (override with `PORT`).

## Environment Variables

See [`.env.example`](.env.example) for the full template. Production-required keys:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing secret (32+ random bytes) |
| `API_KEY` | Shared API key for server-side validation |
| `CUSTODY_ENCRYPT_KEY` | Custodial wallet encryption key (≥ 32 chars) |
| `RPC_URL` | Polygon RPC endpoint |

> **Never commit `.env` to version control.** Use `.env.example` as a template only.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Compile TypeScript + Prisma generate |
| `npm run start` | Production start (requires build) |
| `npm run start:copy-worker` | Copy-trade dispatch worker |
| `npm run start:smart-money-worker` | Smart-money cron worker |
| `npm run seed:admin:dev` | Seed admin account (dev) |
| `npm test` | Run test suite |

## Deployment

```bash
npm run build:deploy   # outputs deploy/ directory
```

Upload `deploy/` to your server, copy `.env.example` → `.env`, run `npm install --omit=dev`, then `npm start`.

See [deploy/README.md](deploy/README.md) and [docs/production-launch-checklist.md](docs/production-launch-checklist.md) for production checklist.

## Documentation

| Doc | Topic |
|-----|-------|
| [auth-api.md](docs/auth-api.md) | Authentication & sessions |
| [trade-api.md](docs/trade-api.md) | Trading endpoints |
| [wallet-api.md](docs/wallet-api.md) | Wallet & custody |
| [smart-money-api.md](docs/smart-money-api.md) | Smart money leaderboard |
| [go-wallet-thin.md](docs/go-wallet-thin.md) | Go wallet integration |
| [error-codes.md](docs/error-codes.md) | API error reference |

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Frontend   │────▶│  Express API     │────▶│  PostgreSQL │
│  (Next.js)  │     │  (this repo)     │     │  + Prisma   │
└─────────────┘     └────────┬─────────┘     └─────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────────┐
        │  NATS    │  │ Go Wallet│  │ Polymarket   │
        │  (copy)  │  │  (sign)  │  │ CLOB + Chain │
        └──────────┘  └──────────┘  └──────────────┘
```

## Tech Stack

- **Runtime:** Node.js 20+, TypeScript 5
- **Framework:** Express 5, Zod validation
- **Database:** PostgreSQL + Prisma 7
- **Blockchain:** ethers.js, viem, Polygon (chain 137)
- **Messaging:** NATS (copy-trade robot control)
- **Observability:** pino logging, prom-client metrics
