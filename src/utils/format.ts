import { Prisma } from '../generated/prisma/client';

/** 与 Prisma Decimal 序列化到 API 的惯例一致 */
export function decimalToString(value: Prisma.Decimal | number | string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  return value.toString();
}
