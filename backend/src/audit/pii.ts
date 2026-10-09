// §11: PII maskalama log-larda və audit-də (VÖEN, FİN, IBAN, telefon).

// VÖEN: 10 rəqəm
const VOEN_REGEX = /\b(\d{4})\d{4}(\d{2})\b/g;
// AZ IBAN: AZ + 2 yoxlama rəqəmi + 4 simvol bank kodu + 20 simvol hesab = 28
const AZ_IBAN_REGEX = /\b(AZ\d{2}[A-Z0-9]{4})[A-Z0-9]{16}([A-Z0-9]{4})\b/g;
// Telefon: +994(50|51|55|70|77|10|99)… və ya 0(50|…)…
const PHONE_REGEX =
  /(?:\+994[\s-]?0?|0)(50|51|55|70|77|10|99)[\s-]?(\d{3})[\s-]?(\d{2})[\s-]?(\d{2})/g;

/** Düz mətndə həssas identifikatorları maskalayır. Sıra vacibdir: IBAN → telefon → VÖEN. */
export function maskText(input: string): string {
  return input
    .replace(AZ_IBAN_REGEX, (_m, head: string, tail: string) => `${head}****************${tail}`)
    .replace(PHONE_REGEX, (_m, operator: string, _a: string, _b: string, end: string) => {
      return `(0${operator})***-**-${end}`;
    })
    .replace(VOEN_REGEX, (_m, head: string, tail: string) => `${head}****${tail}`);
}

const SECRET_KEY = /password|secret|token/i;

/** JSON-u rekursiv maskalayır; parol/secret/token açarları tam gizlədilir. */
export function maskJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map(maskJsonValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        out[key] = '[REDACTED]';
      } else if (key.toLowerCase() === 'fin' && typeof v === 'string') {
        out[key] = v.length === 7 ? `${v.slice(0, 2)}***${v.slice(5)}` : '[MASKED_FIN]';
      } else {
        out[key] = maskJsonValue(v);
      }
    }
    return out;
  }
  return value;
}
