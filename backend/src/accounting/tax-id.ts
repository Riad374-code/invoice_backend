export interface TaxIdCheck {
  valid: boolean;
  /** Normallaşdırılmış (boşluqsuz, böyük hərf) dəyər — yalnız valid olduqda. */
  normalized?: string;
  reason?: string;
}

const ok = (normalized: string): TaxIdCheck => ({ valid: true, normalized });
const bad = (reason: string): TaxIdCheck => ({ valid: false, reason });

/** VÖEN: 10 rəqəm. */
export function validateVoen(input: string): TaxIdCheck {
  const v = input.replace(/\s+/g, '');
  if (!/^\d{10}$/.test(v)) return bad('VÖEN must consist of exactly 10 digits');
  if (/^0{10}$/.test(v)) return bad('VÖEN cannot be all zeros');
  return ok(v);
}

/** FİN: 7 simvol (rəqəm və böyük latın hərfləri). */
export function validateFin(input: string): TaxIdCheck {
  const v = input.replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-Z]{7}$/.test(v)) return bad('FİN must consist of exactly 7 letters/digits');
  return ok(v);
}

/** ISO 13616 mod-97 (BigInt ilə, ədədi bölünmə səhvi riski yoxdur). */
function mod97(numeric: string): bigint {
  return BigInt(numeric) % 97n;
}

function ibanToNumeric(rearranged: string): string {
  return [...rearranged]
    .map((ch) => (ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch))
    .join('');
}

/** AZ IBAN: 28 simvol — `AZ` + 2 yoxlama rəqəmi + 4 hərf bank kodu + 20 rəqəm/hərf hesab, mod-97 = 1. */
export function validateIbanAz(input: string): TaxIdCheck {
  const v = input.replace(/\s+/g, '').toUpperCase();
  if (v.length !== 28) return bad('Azerbaijani IBAN must be exactly 28 characters');
  if (!/^AZ\d{2}[A-Z]{4}[0-9A-Z]{20}$/.test(v)) {
    return bad('IBAN must look like AZkk BBBB + 20 alphanumeric characters');
  }
  const rearranged = v.slice(4) + v.slice(0, 4);
  if (mod97(ibanToNumeric(rearranged)) !== 1n) return bad('IBAN check digits are invalid');
  return ok(v);
}

/** Yoxlama rəqəmlərini hesablayıb düzgün AZ IBAN qurur (testlər və nümunə məlumat üçün). */
export function buildIbanAz(bankCode: string, account: string): string {
  const bban = `${bankCode}${account}`.toUpperCase();
  if (!/^[A-Z]{4}[0-9A-Z]{20}$/.test(bban))
    throw new Error('bankCode must be 4 letters and account 20 alphanumerics');
  const check = 98n - mod97(ibanToNumeric(`${bban}AZ00`));
  return `AZ${String(check).padStart(2, '0')}${bban}`;
}
