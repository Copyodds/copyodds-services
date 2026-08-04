/** UTC calendar day used for Share-to-X daily claim uniqueness. */
export function utcClaimDate(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
