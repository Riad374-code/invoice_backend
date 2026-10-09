export type Lang = 'az' | 'ru' | 'en';

/** Yüngül dil aşkarlama: kirill → ru; ə/ı/ğ/ş/ç/ö/ü → az; ASCII-də tipik AZ söz hissələri → az; əks halda en. */
export function detectLanguage(text: string): Lang {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (!letters) return 'en';
  const cyr = (letters.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  if (cyr / letters.length > 0.3) return 'ru';
  if (/[əıĞğŞşÇçÖöÜüƏİ]/.test(text)) return 'az';
  if (/\b(vergi|madd[eə]|qanun|haqqında|müəssis|şirkət|hesab|qaim[eə]|ədv|edv)\w*/i.test(text))
    return 'az';
  return 'en';
}
