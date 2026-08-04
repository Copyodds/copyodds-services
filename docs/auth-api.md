# 用户登录 API 文档

本文档描述基于邮箱验证码（OTP）+ JWT 的用户认证接口、校验规则与数据库设计。不支持密码登录、重置或修改密码。

---

## 1. 通用响应格式

所有接口统一返回 `{ code, data }`：

- **成功**：`{ "code": 0, "data": <业务数据> }`，HTTP 状态码 200/201
- **失败**：`{ "code": <非零>, "data": { "message": "...", ... } }`，HTTP 状态码 4xx/5xx

**业务码 (code)**

| code | 说明 |
|------|------|
| 0 | 成功 |
| 40001 | 参数/校验错误 (BAD_REQUEST) |
| 40101 | 未登录或 token 无效 (UNAUTHORIZED) |
| 40301 | 无权限 (FORBIDDEN) |
| 40401 | 资源不存在 (NOT_FOUND) |
| 40901 | 冲突，如用户名已存在、钱包已绑定他人 (CONFLICT) |
| 42901 | 请求过于频繁 (TOO_MANY_REQUESTS) |
| 50001 | 服务器/配置错误 (INTERNAL_ERROR) |
| 50021 | 依赖服务不可用，如 Redis/Resend (DEPENDENCY_UNAVAILABLE) |

前端可用 `code === 0` 判断成功，失败时从 `data.message` 取提示文案；若有 `data.details` 则为校验详情。

---

## 2. 环境配置

在项目根目录 `.env` 中配置：

| 变量 | 必填 | 说明 |
|------|------|------|
| `JWT_SECRET` | 是 | 用于签发/校验 JWT，建议 32 位以上随机字符串 |
| `JWT_EXPIRES_IN` | 否 | JWT 过期时间，默认 `7d`（如 `1h`、`7d`） |
| `EMAIL_CODE_PEPPER` | 推荐 | 验证码 HMAC 盐；未设时回退 `JWT_SECRET` |
| `EMAIL_PROVIDER` | 是 | `resend` 或 `gmail_smtp` |
| `MAIL_FROM` | 是 | 发件人，如 `CopyOdds <you@gmail.com>` |
| `SMTP_HOST` | gmail 时 | 默认 `smtp.gmail.com` |
| `SMTP_PORT` | gmail 时 | 默认 `465` |
| `SMTP_SECURE` | gmail 时 | `true`（465）或 `false`（587 STARTTLS） |
| `SMTP_USER` | gmail 时 | Gmail 地址 |
| `SMTP_PASS` | gmail 时 | Google **应用专用密码**（非登录密码） |
| `RESEND_API_KEY` | resend 时 | Resend API Key |
| `EMAIL_CODE_TEST_MODE` | resend 测试 | 未验证域名时转发到 `EMAIL_CODE_TEST_TO` |
| `EMAIL_CODE_TEST_TO` | resend 测试 | Resend 注册邮箱 |
| `EMAIL_CODE_PEPPER` | 否 | 验证码 HMAC 盐；未设时使用 `JWT_SECRET` |

---

## 3. 数据库

### User 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | Int (PK) | 主键，自增 |
| `username` | String (unique) | 系统内部用户名，注册时自动生成，用于内部兼容与展示 |
| `email` | String? (unique) | 登录邮箱；新注册用户必填，历史用户可能为空 |
| `emailVerified` | Boolean | 邮箱是否已通过验证码验证；注册成功且校验验证码后为 `true` |
| `firstName` | String? | 名 |
| `lastName` | String? | 姓 |
| `termsAcceptedAt` | DateTime? | 同意条款时间 |
| `inviteCode` | String (unique) | 当前用户自己的邀请码 |
| `referrerId` | Int? (FK → User.id) | 邀请该用户的上级用户 ID |
| `referralPath` | String? | 推广链路快照，格式如 `1>8>12` |
| `referrerBoundAt` | DateTime? | 上级关系绑定时间 |
| `referrerBindSource` | String? | 上级关系绑定来源，当前为 `REGISTER` |
| `referrerLockedAt` | DateTime? | 推广关系锁定时间 |
| `createdAt` | DateTime | 注册时间 |
| `updatedAt` | DateTime | 最后更新时间 |

### Wallet 表（与用户关联）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | Int (PK) | 主键，自增 |
| `address` | String (unique) | 钱包地址（EVM 0x + 40 位十六进制） |
| `userId` | Int? (FK → User.id) | 关联用户，可选；删除用户时置为 NULL |
| `createdAt` | DateTime | 创建时间 |

一个用户可绑定多个钱包；一个钱包只能绑定一个用户（或未绑定）。

---

## 4. 接口说明

基础路径：`/api/auth`（无需 API Key）。

### 4.1 注册

**POST** `/api/auth/register`

**Request Body (JSON)**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `firstName` | string | 是 | 名，去首尾空格后不能为空 |
| `lastName` | string | 是 | 姓，去首尾空格后不能为空 |
| `email` | string | 是 | 邮箱，保存时会转成小写 |
| `code` | string | 是 | 6 位数字注册验证码（先调用 `POST /email-code/register`） |
| `agreeToTerms` | boolean | 是 | 必须传 `true` |
| `inviteCode` | string | 否 | 邀请码（11 位，区分大小写，可含数字；排除易混淆字符 0/O、1/l/i/I），去首尾空格后校验 |

**成功 (201)**：与登录相同，返回 `token` + `user`，注册后自动登录。

```json
{
  "code": 0,
  "data": {
    "token": "eyJ...",
    "user": { "id": 1, "username": "john-doe", "email": "john@example.com", ... }
  }
}
```

**失败**

- **400** 参数校验失败：`{ "code": 40001, "data": { "message": "Validation failed", "details": { ... } } }`
- **400** 邀请码无效或上级链异常：`{ "code": 40001, "data": { "message": "Invite code is invalid" } }`
- **409** 邮箱已存在：`{ "code": 40901, "data": { "message": "Email already registered" } }`
- **409** 并发冲突（极少数重试场景）：`{ "code": 40901, "data": { "message": "Registration conflict, please retry" } }`
- **400** 验证码错误或已过期：`{ "code": 40011, "data": { "message": "验证码错误或已过期" } }`

**推广绑定规则**

- 注册时如果传了 `inviteCode`，系统会在创建用户时同步绑定上级关系。
- 绑定成功后会同时写入 `referrerId`、`referralPath`、`referrerBoundAt`、`referrerBindSource`、`referrerLockedAt`。
- 无效邀请码不会再静默忽略，而是直接返回 400，避免后续商城分佣时出现“注册成功但关系丢失”。
- 当前推广关系以注册时绑定为准，绑定后视为冻结关系。

---

### 4.1.1 发送注册验证码

**POST** `/api/auth/email-code/register`

**Request Body**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | 是 | 合法邮箱，转小写 |

**成功 (200)**

```json
{ "code": 0, "data": { "success": true, "message": "验证码已发送" } }
```

**失败**：**409** 邮箱已注册；**429** 发送过于频繁或达日/IP 上限；**503** 数据库/Resend 不可用。

**限流**（可通过环境变量调整，见 `.env.example`）：

| 规则 | 默认 |
|------|------|
| 同邮箱同类型冷却 | 60 秒 |
| 注册码 / 邮箱 / 日 | 8 次 |
| 登录码 / 邮箱 / 日 | 24 次 |
| 注册+登录合计 / 邮箱 / 日 | 30 次 |
| 单 IP / 小时 | 80 次 |

验证码 TTL 5 分钟，最多错误 5 次。

---

### 4.1.2 发送登录验证码

**POST** `/api/auth/email-code/login`

**Request Body**：`{ "email": "user@example.com" }`

**成功 (200)**

```json
{ "code": 0, "data": { "success": true, "message": "验证码已发送" } }
```

**失败**

- **404** 邮箱未注册：`{ "code": 40401, "data": { "message": "该邮箱未注册，请先注册" } }`
- **429** 发送过于频繁或达日/IP 上限
- **503** 数据库/邮件服务不可用

---

### 4.2 登录（邮箱验证码）

**POST** `/api/auth/login`

**Request Body (JSON)**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | 是 | 登录邮箱 |
| `code` | string | 是 | 6 位数字（先调用 `POST /email-code/login`） |

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "username": "john-doe",
      "email": "john@example.com",
      "firstName": "John",
      "lastName": "Doe"
    }
  }
}
```

**失败**

- **400** 参数校验失败：`{ "code": 40001, "data": { "message": "Validation failed", "details": { ... } } }`
- **401** 邮箱或验证码错误：`{ "code": 40102, "data": { "message": "邮箱或验证码错误" } }`

---

### 4.3 Token 检测

**GET** `/api/auth/verify`

用于检测当前 token 是否有效（未过期、签名正确）。不查数据库，仅解析 JWT，适合前端做登录态校验。

**Headers**

| 名称 | 必填 | 说明 |
|------|------|------|
| `Authorization` | 是 | `Bearer <token>`，登录接口返回的 JWT |

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "valid": true,
    "user": {
      "userId": 1,
      "username": "testuser"
    }
  }
}
```

**失败**

- **401** 未提供、过期或无效 token：`{ "code": 40101, "data": { "message": "Unauthorized" } }`

---

### 4.4 获取当前用户

**GET** `/api/auth/me`

**Headers**

| 名称 | 必填 | 说明 |
|------|------|------|
| `Authorization` | 是 | `Bearer <token>`，token 为登录接口返回的 JWT |

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "id": 1,
    "email": "john@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "username": "john-doe",
    "inviteCode": "a1b2c3d4e5f",
    "referrerId": 8,
    "referrerBoundAt": "2026-03-14T00:00:00.000Z",
    "referrerBindSource": "REGISTER",
    "affiliateTier": 2
  }
}
```

**失败**

- **401** 未提供或无效 token：`{ "code": 40101, "data": { "message": "Unauthorized" } }`

---

### 4.5 绑定钱包（需登录）

**POST** `/api/auth/wallets`

**Headers**：`Authorization: Bearer <token>`

**Request Body (JSON)**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | EVM 地址，格式 `0x` + 40 位十六进制 |

**成功**

- 首次绑定：**201**，`{ "code": 0, "data": { "id", "address", "userId", "createdAt" } }`
- 已绑定当前用户：**200**，同上（幂等）

**失败**

- **400** 参数错误：`{ "code": 40001, "data": { "message": "Validation failed", "details": ... } }`
- **401** 未登录或 token 无效：`{ "code": 40101, "data": { "message": "Unauthorized" } }`
- **409** 该钱包已绑定其他用户：`{ "code": 40901, "data": { "message": "Wallet already bound to another user" } }`

---

### 4.6 我的钱包列表（需登录）

**GET** `/api/auth/wallets`

**Headers**：`Authorization: Bearer <token>`

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "wallets": [
      { "id": 1, "address": "0x...", "createdAt": "..." }
    ]
  }
}
```

**失败**：**401** `{ "code": 40101, "data": { "message": "Unauthorized" } }`

---

### 4.7 解绑钱包（需登录）

**DELETE** `/api/auth/wallets/:id`

**Headers**：`Authorization: Bearer <token>`

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | number | 钱包记录 ID（来自「我的钱包列表」中的 `id`） |

**成功 (200)**

```json
{ "code": 0, "data": { "message": "Wallet unbound" } }
```

**失败**

- **400** 无效的 wallet id：`{ "code": 40001, "data": { "message": "Invalid wallet id" } }`
- **401** 未登录或 token 无效：`{ "code": 40101, "data": { "message": "Unauthorized" } }`
- **403** 该钱包未绑定当前用户：`{ "code": 40301, "data": { "message": "Wallet not bound to current user" } }`
- **404** 钱包不存在：`{ "code": 40401, "data": { "message": "Wallet not found" } }`

解绑后该钱包记录的 `userId` 置空，钱包记录保留；该钱包可再次被其他用户绑定。

---

## 5. 校验规则

- **注册 firstName / lastName**：去首尾空格后非空
- **注册 email**：合法邮箱格式，保存为小写
- **注册 code**：6 位数字
- **注册 agreeToTerms**：必须为 `true`
- **登录**：`email` + 6 位 `code`；错误统一返回「邮箱或验证码错误」
- **JWT**：由 `JWT_SECRET` 签名，过期时间由 `JWT_EXPIRES_IN` 控制；payload 含 `userId`、`username`、`jti`（会话 ID）

**邮箱验证码（单实例 Node 进程内 TTL 缓存，到期自动清理）**

| 规则 | 值 |
|------|-----|
| TTL | 300 秒 |
| 发送冷却（同邮箱同类型） | 60 秒 |
| 注册码 / 邮箱 / 日 | 8（`EMAIL_CODE_DAILY_REGISTER_MAX`） |
| 登录码 / 邮箱 / 日 | 24（`EMAIL_CODE_DAILY_LOGIN_MAX`） |
| 合计 / 邮箱 / 日 | 30（`EMAIL_CODE_DAILY_COMBINED_MAX`） |
| 每 IP 每小时 | 80（`EMAIL_CODE_IP_HOURLY_MAX`） |
| 最大验证错误次数 | 5 次（超限后需重新发送） |
| 存储 | HMAC-SHA256 哈希，不存明文 |

---

## 6. 在其它接口中使用登录态

需要“已登录”的接口可挂载 `jwtAuth` 中间件，通过 `req.user` 获取当前用户：

- `req.user.userId`：用户 ID
- `req.user.username`：用户名

示例：`app.get('/api/profile', jwtAuth, (req, res) => { ... })`

---

## 7. 测试流程示例

### 7.1 注册 + 登录（含邮箱验证码）

```bash
BASE=http://localhost:3000
EMAIL=test-$(date +%s)@example.com

# 1. 发送注册验证码
curl -s -X POST "$BASE/api/auth/email-code/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\"}"

# 2. 从邮箱获取 6 位 code 后注册
curl -s -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"firstName\":\"John\",\"lastName\":\"Doe\",\"email\":\"$EMAIL\",\"code\":\"123456\",\"agreeToTerms\":true}"

# 3. 发送登录验证码（须已注册）
curl -s -X POST "$BASE/api/auth/email-code/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\"}"

# 4. 登录（使用登录邮件中的 code）
curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"code\":\"123456\"}"
```

PowerShell 示例：

```powershell
$Base = "http://localhost:3000"
$Email = "test-$(Get-Date -UFormat %s)@example.com"
Invoke-RestMethod -Method Post -Uri "$Base/api/auth/email-code/register" -ContentType "application/json" -Body (@{ email = $Email } | ConvertTo-Json)
# 填入邮件中的 code
Invoke-RestMethod -Method Post -Uri "$Base/api/auth/register" -ContentType "application/json" -Body (@{
  firstName = "John"; lastName = "Doe"; email = $Email
  code = "123456"; agreeToTerms = $true
} | ConvertTo-Json)
```

### 7.2 其它接口

1. 当前用户：`GET /api/auth/me`，Header `Authorization: Bearer <token>`
2. 我的钱包：`GET /api/auth/wallets`，Header `Authorization: Bearer <token>`

**前置**：`RESEND_API_KEY` 或 Gmail SMTP、`MAIL_FROM`、`EMAIL_CODE_PEPPER`（或 `JWT_SECRET`）；执行迁移 `npx prisma migrate deploy`。

### 7.5 Gmail SMTP（推荐未验证 Resend 域名时）

```env
EMAIL_PROVIDER=gmail_smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
MAIL_FROM=CopyOdds <you@gmail.com>
```

在 Google 账号开启两步验证后创建「应用专用密码」。验证码会发到用户填写的真实邮箱。

### 7.6 Resend 测试模式（`EMAIL_PROVIDER=resend` 且未验证域名）

见 `EMAIL_CODE_TEST_TO` / `EMAIL_CODE_TEST_MODE`；验证域名后改用生产 `MAIL_FROM`。

---

## 8. Passkey (WebAuthn)

Passkey 作为邮箱 OTP 的**补充**登录与绑定方式。需配置 `PASSKEY_RP_ID` 与 `PASSKEY_ORIGINS`；未配置时 Passkey 端点返回 `50301`。

| 变量 | 说明 |
|------|------|
| `PASSKEY_RP_ID` | Relying Party ID，如 `localhost` 或 `app.example.com` |
| `PASSKEY_RP_NAME` | 展示名称，默认 `CopyOdds` |
| `PASSKEY_ORIGINS` | 逗号分隔的前端 Origin 白名单 |
| `PASSKEY_CHALLENGE_TTL_SECONDS` | Challenge TTL，默认 600 |
| `PASSKEY_USER_VERIFICATION` | `required` / `preferred` / `discouraged` |

### 8.1 绑定 Passkey（需登录）

**POST** `/api/auth/passkey/register/options`  
Header: `Authorization: Bearer <token>`  
Body: `{ "label": "optional device name" }`  
Response: `{ "requestId", "publicKey" }`（WebAuthn creation options）

**POST** `/api/auth/passkey/register/verify`  
Header: `Authorization: Bearer <token>`  
Body: WebAuthn attestation JSON + `requestId`  
Response: `{ "success": true }`

### 8.2 Passkey 登录（Named Login，需先输入邮箱）

**POST** `/api/auth/passkey/login/options`  
Body: `{ "email": "user@example.com" }`  
Response: `{ "requestId", "publicKey" }`（含 `allowCredentials`）

**POST** `/api/auth/passkey/login/verify`  
Body: WebAuthn assertion JSON + `requestId` + `email`  
Response: 与 `POST /api/auth/login` 相同 `{ "token", "user" }` + Set-Cookie

### 8.3 管理

**GET** `/api/auth/passkey/list` — 列出当前用户 Passkey  
**DELETE** `/api/auth/passkey/:id` — 删除指定 Passkey

### 8.4 Passkey 业务码

| code | 说明 |
|------|------|
| 50301 | Passkey 未配置 |
| 40031 | Challenge 过期 |
| 40131 | 验证失败 |
| 40403 | 用户无 Passkey / credential 不存在 |
| 40401 | 邮箱未注册（login/options） |

---

## 9. Authenticator TOTP（提现 step-up）

仅用于**提现二次验证**，不接入登录。用户 TOTP 种子与验证状态由 Go wallet-api 管理；
Node 不保存/解密用户种子，也不为 TOTP 签发 step-up JWT。Node 的
`TOTP_SECRET_ENCRYPTION_KEY` 只保留给 `AdminUser` 管理员 2FA。

| 变量 | 说明 |
|------|------|
| `GO_WALLET_SERVICE_URL` / `GO_WALLET_APP_*` | 用户 TOTP 与签名服务（缺失或不可用时提现 fail-closed） |
| `TOTP_SECRET_ENCRYPTION_KEY` | 仅管理员 TOTP secret；用户运行时不依赖 |
| `TOTP_ISSUER` | otpauth 展示名，默认 `CopyOdds` |
| `TOTP_VERIFY_MAX_FAILURES` | 失败次数上限（默认 5） |
| `TOTP_VERIFY_LOCK_SEC` | 锁定秒数（默认 300） |

### 9.1 接口（均需 `Authorization: Bearer`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/auth/2fa/status` | `totpEnabled` / `passkeyEnabled` / `preferredMethod` |
| POST | `/api/auth/2fa/totp/setup` | 生成 pending secret，返回 `otpauthUrl`、`manualEntryKey` |
| POST | `/api/auth/2fa/totp/confirm` | Body `{ "code": "123456" }` 完成绑定 |
| POST | `/api/auth/2fa/totp/verify` | Body `{ "purpose":"withdraw", "code":"123456", "to":"0x…", "amount":"1.25", "idempotencyKey":"…" }` → opaque `authorization` |
| POST | `/api/auth/2fa/totp/disable` | Body `{ "code": "123456" }` 关闭 TOTP |

`authorization` 绑定数据库中的 `refer_code`、`walletIndex`、Polygon、deposit wallet、USDC.e
以及请求的 `to`、`amount`、`idempotencyKey`，仅可用于对应一次
`withdraw-polymarket-deposit-v2`。旧 deposit 提现与用户 EOA `/withdraw` 已禁用。

### 9.2 TOTP 业务码

| code | 说明 |
|------|------|
| 40351 | 已开启 TOTP |
| 40352 | 未开启 TOTP |
| 40354 | 绑定 pending 过期 |
| 40355 | 验证码错误 |
| 40356 | 限流 |
| 50302 | 加密密钥未配置 |
