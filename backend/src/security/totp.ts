import { createHmac, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 san., 6 rəqəm). */
export function totpAt(secretBase32: string, timeMs: number, digits = 6, stepSeconds = 30): string {
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** ±1 addım (saat fərqi) tolerantlığı ilə yoxlama. */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number = Date.now(),
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    for (const drift of [-1, 0, 1]) {
      const expected = Buffer.from(totpAt(secretBase32, nowMs + drift * 30_000));
      const given = Buffer.from(code);
      if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
    }
  } catch {
    return false;
  }
  return false;
}
