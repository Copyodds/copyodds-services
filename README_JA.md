<div align="center">

[English](README.md) · [简体中文](README_CN.md) · 日本語 · [한국어](README_KO.md) · [Português do Brasil](README_PT-BR.md)

# Polymarket Agent Backend

**Polymarket 向けコピートレード、スマートマネー発見、カストディアルウォレット API。**

本番環境対応の Node.js バックエンド。ユーザー認証、コピートレード実行、スマートマネーランキング、カストディアル入金、管理機能を提供 — Polymarket CLOB と Polygon オンチェーン決済に対応。

[公式サイト](https://app.copyodds.io/) - CopyOdds を今すぐ体験する。

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

## 免責事項および利用制限

本ソフトウェアは、明示または黙示を問わずいかなる保証もなく「**現状有姿**」で提供されます。

**事前許諾が必要です。** 本ソフトウェアへのアクセス、使用、改変、デプロイ、再配布（本番または商用デプロイを含む）には、著作権者 / プロジェクトメンテナーからの**事前の書面による許諾**が必要です。無断利用は禁止します。許諾が必要な場合はメンテナーまでご連絡ください。

**非公式・非提携。** 本プロジェクトは独立した第三者によるものであり、Polymarket、Polygon、またはその関連団体と**一切の提携・後援・スポンサー・公式関係はありません**。商標は各権利者に帰属し、説明または相互運用の目的でのみ使用しています。

**法域および合法性。** 予測市場、コピートレード、自動取引、カストディアルウォレットサービス、またはこれらに類する行為が適用法により制限もしくは禁止されている国・地域、またはそのような行為が禁止されている者に対して、本ソフトウェアを使用・提供・運営・ホスティングし、または公開しては**なりません**。許諾申請または利用の前に、意図する利用が管轄法上適法かを**ご自身の責任で確認**してください。現地法が当該行為を認めない場合、当該地で本ソフトウェアを開放・デプロイ・提供しては**なりません**。

**金融アドバイスではありません。** 本リポジトリの内容は、投資・取引・法律・税務・財務に関する助言を構成しません。予測市場および暗号資産の取引には、資金の全損を含む重大な損失リスクがあります。

**自己責任。** 許諾を得た場合でも、設定とセキュリティ（秘密鍵、カストディ暗号化キー、API シークレット、ウォレット基盤など）、コンプライアンス（AML/KYC、制裁、証券、賭博、税務等、該当する場合）、および一切の結果はご自身の責任です。作者および貢献者は、本ソフトウェアの利用に起因する資金・データ・利益の損失、損害、または規制上の結果について**責任を負いません**。

**教育・研究の位置づけ。** ソースコードは [LICENSE](LICENSE) の条件に基づき教育・研究の議論のために公開される場合がありますが、上記の許諾要件および法域制限に服します。コピートレード、カストディアルウォレット、または自動注文執行の本番利用は、**事前の書面許諾があり、かつ適法な場合に限り**認められます。

許諾がない場合、または現地法が当該活動を認めない場合は、**本ソフトウェアを使用しないでください**。
