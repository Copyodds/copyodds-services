<div align="center">

[English](README.md) · [简体中文](README_CN.md) · [日本語](README_JA.md) · **한국어** · [Português do Brasil](README_PT-BR.md)

# Polymarket Agent Backend

**Polymarket용 카피 트레이딩, 스마트 머니 발견, 커스터디얼 지갑 API 백엔드.**

프로덕션급 Node.js 백엔드 — 사용자 인증, 카피 트레이드 실행, 스마트 머니 리더보드, 커스터디얼 입금, 관리 기능을 제공합니다. Polymarket CLOB 및 Polygon 온체인 결제 기반.

[공식 웹사이트](https://app.copyodds.io/) - 지금 바로 CopyOdds를 시작하세요.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Prisma-4169E1?logo=postgresql&logoColor=white)](https://www.prisma.io/)
[![Polymarket](https://img.shields.io/badge/Polymarket-CLOB-6366F1)](https://polymarket.com/)
[![Polygon](https://img.shields.io/badge/Polygon-137-8247E5?logo=polygon&logoColor=white)](https://polygon.technology/)

</div>

---

## 기능

| 모듈 | 설명 |
|------|------|
| **카피 트레이딩** | 리더 구독, 자동 주문 발송, 재시도 및 자금 확인, 손익 원장 |
| **스마트 머니** | 리더보드 점수, 트레이더 프로필, 카피 풀 게이팅, 온디맨드 분석 |
| **커스터디얼 지갑** | EOA 입금 전달, Polymarket 입금, Go 지갑 원격 서명 |
| **가상 카피** | 페이퍼 트레이딩 시뮬레이션 (호가창 체결 및 결제) |
| **인증 및 보안** | JWT 세션, Passkey, TOTP 2차 인증, SSRF 방어 |
| **관리** | 대시보드 Cron, 리스크 관리, 제휴 등급, Gas 패키지 |

## 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 설정
cp .env.example .env
# DATABASE_URL, JWT_SECRET, API_KEY, RPC_URL 등 입력

# 3. Prisma Client 생성 및 마이그레이션
npx prisma migrate dev

# 4. 개발 서버 시작 (핫 리로드)
npm run dev
```

기본 API 주소: `http://localhost:3000` (`PORT`로 변경 가능).

## 환경 변수

전체 템플릿은 [`.env.example`](.env.example) 참조. 프로덕션 필수 항목:

| 변수 | 용도 |
|------|------|
| `DATABASE_URL` | PostgreSQL 연결 문자열 |
| `JWT_SECRET` | JWT 서명 시크릿 (32+ 랜덤 바이트) |
| `API_KEY` | 서버 측 공유 API 키 |
| `CUSTODY_ENCRYPT_KEY` | 커스터디얼 암호화 키 (32자 이상) |
| `RPC_URL` | Polygon RPC 엔드포인트 |

> **`.env`를 Git에 커밋하지 마세요.** `.env.example`을 템플릿으로만 사용하세요.

## 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev` | 개발 서버 (핫 리로드) |
| `npm run build` | TypeScript 컴파일 + Prisma generate |
| `npm run start` | 프로덕션 시작 (빌드 필요) |
| `npm run start:copy-worker` | 카피 트레이드 디스패치 Worker |
| `npm run start:smart-money-worker` | 스마트 머니 Cron Worker |
| `npm run seed:admin:dev` | 관리자 계정 생성 (개발) |
| `npm test` | 테스트 스위트 실행 |

## 배포

```bash
npm run build:deploy   # deploy/ 디렉토리 생성
```

`deploy/`를 서버에 업로드하고, `.env.example` → `.env` 복사, `npm install --omit=dev` 후 `npm start`.

자세한 내용은 [deploy/README.md](deploy/README.md) 및 [docs/production-launch-checklist.md](docs/production-launch-checklist.md) 참조.

## 문서

| 문서 | 주제 |
|------|------|
| [auth-api.md](docs/auth-api.md) | 인증 및 세션 |
| [trade-api.md](docs/trade-api.md) | 거래 엔드포인트 |
| [wallet-api.md](docs/wallet-api.md) | 지갑 및 커스터디 |
| [smart-money-api.md](docs/smart-money-api.md) | 스마트 머니 리더보드 |
| [go-wallet-thin.md](docs/go-wallet-thin.md) | Go 지갑 연동 |
| [error-codes.md](docs/error-codes.md) | API 오류 코드 |

## 아키텍처

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  프론트엔드 │────▶│  Express API     │────▶│  PostgreSQL │
│  (Next.js)  │     │  (본 저장소)     │     │  + Prisma   │
└─────────────┘     └────────┬─────────┘     └─────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────────┐
        │  NATS    │  │ Go Wallet│  │ Polymarket   │
        │  (카피)  │  │  (서명)  │  │ CLOB + 체인  │
        └──────────┘  └──────────┘  └──────────────┘
```

## 기술 스택

- **런타임:** Node.js 20+, TypeScript 5
- **프레임워크:** Express 5, Zod 검증
- **데이터베이스:** PostgreSQL + Prisma 7
- **블록체인:** ethers.js, viem, Polygon (chain 137)
- **메시징:** NATS (카피 트레이드 로봇 제어)
- **관측성:** pino 로깅, prom-client 메트릭
