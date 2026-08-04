import { z } from 'zod';

export const EMAIL_MAX = 320;

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'email is required')
  .max(EMAIL_MAX, 'email is too long')
  .email('invalid email')
  .transform((value) => value.toLowerCase());

export const codeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'code must be 6 digits');

export const emailOnlyBodySchema = z.object({
  email: emailSchema,
});

export const loginBodySchema = z.object({
  email: emailSchema,
  code: codeSchema,
});

/** Passkey login: email optional — empty/missing triggers discoverable (device passkey) login. */
export const passkeyLoginOptionsBodySchema = z.object({
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX)
    .optional()
    .transform((value) => (value ?? '').trim().toLowerCase())
    .refine((value) => value === '' || z.string().email().safeParse(value).success, 'invalid email'),
});

export const passkeyLoginVerifyBodySchema = z.object({
  requestId: z.string().trim().min(1).max(64),
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX)
    .optional()
    .transform((value) => (value ?? '').trim().toLowerCase())
    .refine((value) => value === '' || z.string().email().safeParse(value).success, 'invalid email'),
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().nullable().optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});
