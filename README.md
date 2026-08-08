<div align="center">

English · [简体中文](README_CN.md) · [日本語](README_JA.md) · [한국어](README_KO.md) · [Português do Brasil](README_PT-BR.md)

# Polymarket Agent Backend

**Copy trading, smart-money discovery, and custodial wallet APIs for Polymarket.**

A production-grade Node.js backend that powers user auth, copy-trade execution, smart-money leaderboards, custodial deposits, and admin operations — built for Polymarket CLOB and on-chain settlement on Polygon.

[Official Website](https://app.copyodds.io/) - Start using CopyOdds now.

[Telegram Bot](https://t.me/copyodds_bot) - Open `@copyodds_bot` for wallet updates, portfolio checks, and CopyOdds support.

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

## Trust & Safety

This repository is designed for teams that care about operational reliability, transparent risk controls, and responsible deployment.

- **Security-first defaults:** JWT-backed sessions, passkeys, TOTP step-up for sensitive flows, SSRF guardrails, request size limits, secret-based internal routes, and structured log redaction.
- **Financial controls:** funding checks, retry boundaries, copy-trade risk gates, settlement/redeem safeguards, audit events, and admin visibility for operational review.
- **Operational transparency:** Prisma migrations, health checks, worker separation, metrics, production checklists, and documented API behavior.
- **Deployment responsibility:** production operators are expected to use strong secrets, private infrastructure for wallet services, restricted admin access, monitoring, backups, and jurisdiction-specific compliance review.

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

## Disclaimer & Responsible Use

This software is provided **as is**, without warranty of any kind, express or implied. It is shared for engineering review, education, research, and authorized deployments only.

**Independent project.** This repository is an independent third-party project. It is not affiliated with, endorsed by, sponsored by, or officially connected to Polymarket, Polygon, or any related entity. All trademarks belong to their respective owners and are used only for descriptive or interoperability purposes.

**No financial advice.** Nothing in this repository is investment, trading, legal, tax, or financial advice. Prediction-market and cryptocurrency activity can involve substantial risk, including total loss of funds.

**Compliance is your responsibility.** You are responsible for confirming that any use, hosting, copy-trading, automated execution, custodial wallet operation, or related activity is lawful in every jurisdiction where you operate or serve users. Do not use or provide this software where such activity is restricted or prohibited.

**Security is your responsibility.** Production operators are responsible for private keys, custody encryption keys, API secrets, wallet infrastructure, database access, monitoring, incident response, backups, admin access controls, and compliance obligations such as AML/KYC, sanctions, securities, gambling, and tax rules where applicable.

**Liability limitation.** The authors and contributors are not liable for loss of funds, data, profits, business opportunity, reputation, or any direct or indirect damages or regulatory consequences arising from use, modification, deployment, or reliance on this software.

By using this repository, you acknowledge the risks above and agree to deploy it only with proper authorization, security review, and legal/compliance review.
