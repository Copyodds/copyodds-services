<div align="center">

[English](README.md) · [简体中文](README_CN.md) · [日本語](README_JA.md) · [한국어](README_KO.md) · **Português do Brasil**

# Polymarket Agent Backend

**API de copy trading, descoberta de smart money e carteira custodial para Polymarket.**

Backend Node.js de produção que oferece autenticação, execução de copy trade, ranking de smart money, depósitos custodiais e operações administrativas — integrado ao CLOB da Polymarket e liquidação on-chain na Polygon.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Prisma-4169E1?logo=postgresql&logoColor=white)](https://www.prisma.io/)
[![Polymarket](https://img.shields.io/badge/Polymarket-CLOB-6366F1)](https://polymarket.com/)
[![Polygon](https://img.shields.io/badge/Polygon-137-8247E5?logo=polygon&logoColor=white)](https://polygon.technology/)

</div>

---

## Funcionalidades

| Módulo | Descrição |
|--------|-----------|
| **Copy Trading** | Assinar líderes, despacho automático, retry e verificação de fundos, ledger de PnL |
| **Smart Money** | Pontuação de ranking, perfis de traders, controle de copy pool, análise sob demanda |
| **Carteira Custodial** | Encaminhamento de depósito EOA, depósito Polymarket, assinatura remota Go wallet |
| **Copy Virtual** | Simulação paper trading com preenchimento no order book e liquidação |
| **Auth & Segurança** | Sessões JWT, Passkey, step-up TOTP, proteção SSRF |
| **Admin** | Cron de dashboard, controles de risco, tiers de afiliados, pacotes de gas |

## Início Rápido

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Preencher DATABASE_URL, JWT_SECRET, API_KEY, RPC_URL, etc.

# 3. Gerar Prisma Client e executar migrations
npx prisma migrate dev

# 4. Iniciar servidor de desenvolvimento (hot reload)
npm run dev
```

API padrão em `http://localhost:3000` (altere com `PORT`).

## Variáveis de Ambiente

Veja [`.env.example`](.env.example) para o template completo. Obrigatórias em produção:

| Variável | Propósito |
|----------|-----------|
| `DATABASE_URL` | String de conexão PostgreSQL |
| `JWT_SECRET` | Segredo de assinatura JWT (32+ bytes aleatórios) |
| `API_KEY` | Chave API compartilhada para validação server-side |
| `CUSTODY_ENCRYPT_KEY` | Chave de criptografia custodial (≥ 32 caracteres) |
| `RPC_URL` | Endpoint RPC Polygon |

> **Nunca commite `.env` no controle de versão.** Use `.env.example` apenas como template.

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Servidor de desenvolvimento (hot reload) |
| `npm run build` | Compilar TypeScript + Prisma generate |
| `npm run start` | Iniciar produção (requer build) |
| `npm run start:copy-worker` | Worker de despacho copy trade |
| `npm run start:smart-money-worker` | Worker cron smart money |
| `npm run seed:admin:dev` | Criar conta admin (dev) |
| `npm test` | Executar suite de testes |

## Deploy

```bash
npm run build:deploy   # gera diretório deploy/
```

Faça upload de `deploy/` para o servidor, copie `.env.example` → `.env`, execute `npm install --omit=dev`, depois `npm start`.

Consulte [deploy/README.md](deploy/README.md) e [docs/production-launch-checklist.md](docs/production-launch-checklist.md) para checklist de produção.

## Documentação

| Doc | Tópico |
|-----|--------|
| [auth-api.md](docs/auth-api.md) | Autenticação e sessões |
| [trade-api.md](docs/trade-api.md) | Endpoints de trading |
| [wallet-api.md](docs/wallet-api.md) | Carteira e custódia |
| [smart-money-api.md](docs/smart-money-api.md) | Ranking smart money |
| [go-wallet-thin.md](docs/go-wallet-thin.md) | Integração Go wallet |
| [error-codes.md](docs/error-codes.md) | Referência de erros API |

## Arquitetura

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Frontend   │────▶│  Express API     │────▶│  PostgreSQL │
│  (Next.js)  │     │  (este repo)     │     │  + Prisma   │
└─────────────┘     └────────┬─────────┘     └─────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────────┐
        │  NATS    │  │ Go Wallet│  │ Polymarket   │
        │  (copy)  │  │  (sign)  │  │ CLOB + Chain │
        └──────────┘  └──────────┘  └──────────────┘
```

## Stack Tecnológica

- **Runtime:** Node.js 20+, TypeScript 5
- **Framework:** Express 5, validação Zod
- **Banco de dados:** PostgreSQL + Prisma 7
- **Blockchain:** ethers.js, viem, Polygon (chain 137)
- **Mensageria:** NATS (controle de robô copy trade)
- **Observabilidade:** logging pino, métricas prom-client
