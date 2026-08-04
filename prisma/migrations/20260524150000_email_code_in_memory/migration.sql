-- 单实例 backend：验证码改进程内 TTL，不再落库
DROP TABLE IF EXISTS "email_verification_codes";
DROP TYPE IF EXISTS "EmailVerificationCodeType";
