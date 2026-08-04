/** Step-up verification purposes (extend for future sensitive actions). */
export const STEP_UP_PURPOSE = {
  WITHDRAW: 'withdraw',
} as const;

export type StepUpPurpose = (typeof STEP_UP_PURPOSE)[keyof typeof STEP_UP_PURPOSE];

/** Methods that can issue a step-up token today. */
export type StepUpMethod = 'passkey' | 'email_otp' | 'totp';

export const STEP_UP_TOKEN_TTL_SEC = Math.max(
  60,
  Number(process.env.STEP_UP_TOKEN_TTL_SEC ?? 300) || 300
);

export const STEP_UP_JWT_TYP = 'step_up' as const;
