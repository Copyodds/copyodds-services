<div align="center">

[English](README.md) · [简体中文](README_CN.md) · **日本語** · [한국어](README_KO.md) · [Português do Brasil](README_PT-BR.md)

# Polymarket Agent Backend

**Polymarket 向けコピートレード、スマートマネー発見、カストディアルウォレット API。**

本番環境対応の Node.js バックエンド。ユーザー認証、コピートレード実行、スマートマネーランキング、カストディアル入金、管理機能を提供 — Polymarket CLOB と Polygon オンチェーン決済に対応。

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Prisma-4169E1?logo=postgresql&logoColor=white)](https://www.prisma.io/)
[![Polymarket](https://img.shields.io/badge/Polymarket-CLOB-6366F1)](https://polymarket.com/)
[![Polygon](https://img.shields.io/badge/Polygon-137-8247E5?logo=polygon&logoColor=white)](https://polygon.technology/)

</div>

---

## 機能

| モジュール | 説明 |
|-----------|------|
| **コピートレード** | リーダー購読、自動発注、リトライ・資金チェック、損益台帳 |
| **スマートマネー** | ランキングスコア、トレーダープロフィール、コピープール制御 |
| **カストディアルウォレット** | EOA 入金転送、Polymarket 入金、Go ウォレットリモート署名 |
| **バーチャルコピー** | ペーパートレードシミュレーション（板情報約定・決済） |
| **認証・セキュリティ** | JWT セッション、Passkey、TOTP ステップアップ、SSRF ガード |
| **管理** | ダッシュボード Cron、リスク管理、アフィリエイト、Gas パッケージ |

## クイックスタート

```bash
# 1. 依存関係をインストール
npm install

# 2. 環境変数を設定
cp .env.example .env
# DATABASE_URL、JWT_SECRET、API_KEY、RPC_URL などを入力

# 3. Prisma Client 生成とマイグレーション
npx prisma migrate dev

# 4. 開発サーバー起動（ホットリロード）
npm run dev
```

デフォルト API: `http://localhost:3000`（`PORT` で変更可能）。

## 環境変数

完全なテンプレートは [`.env.example`](.env.example) を参照。本番必須項目：

| 変数 | 用途 |
|------|------|
| `DATABASE_URL` | PostgreSQL 接続文字列 |
| `JWT_SECRET` | JWT 署名シークレット（32+ ランダムバイト） |
| `API_KEY` | サーバー側共有 API キー |
| `CUSTODY_ENCRYPT_KEY` | カストディアル暗号化キー（32 文字以上） |
| `RPC_URL` | Polygon RPC エンドポイント |
| `CUSTODY_TREASURY_ADDRESS` | 国庫受取専用アドレス |

> **`.env` を Git にコミットしないでください。** `.env.example` をテンプレートとして使用。

## スクリプト

| コマンド | 説明 |
|---------|------|
| `npm run dev` | 開発サーバー（ホットリロード） |
| `npm run build` | TypeScript コンパイル + Prisma generate |
| `npm run start` | 本番起動（ビルド必須） |
| `npm run start:copy-worker` | コピートレード配信 Worker |
| `npm run start:smart-money-worker` | スマートマネー Cron Worker |
| `npm run seed:admin:dev` | 管理アカウント作成（開発） |
| `npm test` | テストスイート実行 |

## デプロイ

```bash
npm run build:deploy   # deploy/ ディレクトリを生成
```

`deploy/` をサーバーにアップロードし、`.env.example` → `.env` をコピー、`npm install --omit=dev` の後 `npm start`。

詳細は [deploy/README.md](deploy/README.md) と [docs/production-launch-checklist.md](docs/production-launch-checklist.md) を参照。

## ドキュメント

| ドキュメント | トピック |
|-------------|---------|
| [auth-api.md](docs/auth-api.md) | 認証とセッション |
| [trade-api.md](docs/trade-api.md) | 取引エンドポイント |
| [wallet-api.md](docs/wallet-api.md) | ウォレットとカストディ |
| [smart-money-api.md](docs/smart-money-api.md) | スマートマネーランキング |
| [go-wallet-thin.md](docs/go-wallet-thin.md) | Go ウォレット連携 |
| [error-codes.md](docs/error-codes.md) | API エラーリファレンス |

## アーキテクチャ

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  フロント   │────▶│  Express API     │────▶│  PostgreSQL │
│  (Next.js)  │     │  (本リポジトリ)  │     │  + Prisma   │
└─────────────┘     └────────┬─────────┘     └─────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────────┐
        │  NATS    │  │ Go Wallet│  │ Polymarket   │
        │  (コピー)│  │  (署名)  │  │ CLOB + チェーン│
        └──────────┘  └──────────┘  └──────────────┘
```

## 技術スタック

- **ランタイム:** Node.js 20+、TypeScript 5
- **フレームワーク:** Express 5、Zod バリデーション
- **データベース:** PostgreSQL + Prisma 7
- **ブロックチェーン:** ethers.js、viem、Polygon（chain 137）
- **メッセージング:** NATS（コピートレード制御）
- **可観測性:** pino ログ、prom-client メトリクス
