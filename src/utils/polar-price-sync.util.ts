/**
 * Polar Billing expects amounts as string integers in the currency's smallest unit
 * (e.g. USD → cents).
 *
 * Most currencies use 2 decimal places; known zero-decimal ISO 4217 codes use exponent 0.
 * Three-decimal currencies (e.g. BHD, KWD) are not represented here and are treated as 2-decimal — verify amounts manually if you add those.
 */

const ZERO_DECIMAL_CURRENCIES = new Set<string>([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

export function currencyMinorExponent(currencyCode: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase()) ? 0 : 2;
}

export function majorToMinorAmountString(
  amountMajor: number,
  currencyCode: string,
): string {
  if (!Number.isFinite(amountMajor) || amountMajor < 0) {
    throw new Error(`Invalid major amount for ${currencyCode}: ${amountMajor}`);
  }
  const exp = currencyMinorExponent(currencyCode);
  const factor = 10 ** exp;
  return String(Math.round(amountMajor * factor));
}

/** Convert Polar amount string (minor units) to decimal major units. */
export function polarAmountStringToMajor(
  amountRaw: unknown,
  currencyCode: string,
): number {
  const code = currencyCode.toUpperCase();
  const s = String(amountRaw ?? '').trim();
  if (!s) return 0;
  const exp = currencyMinorExponent(code);
  /** Polar API returns integer-string minor amounts for typical currencies. */
  if (/^-?\d+$/.test(s)) {
    const minor = Number(s);
    if (!Number.isFinite(minor)) return 0;
    return minor / 10 ** exp;
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Mirrors admin `display_pricing` tier shape (subset). */
export type DisplayTierLike = {
  listMonthly: number;
  listYearly: number;
  offerMonthly: number | null;
  offerYearly: number | null;
};

export function effectiveDisplayAmountMajor(
  tier: DisplayTierLike,
  cycle: 'monthly' | 'yearly',
): number {
  const list = cycle === 'monthly' ? tier.listMonthly : tier.listYearly;
  const offer = cycle === 'monthly' ? tier.offerMonthly : tier.offerYearly;
  if (offer != null && Number.isFinite(offer) && offer < list) {
    return offer;
  }
  return list;
}
