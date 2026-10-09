import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface CbarRate {
  currency: string;
  rate: string;
  nominal: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  processEntities: false,
  isArray: (n) => n === 'Valute' || n === 'ValType',
});

/** CBAR gündəlik XML: <ValCurs Date="DD.MM.YYYY"><ValType><Valute Code="USD"><Nominal>1</Nominal><Value>1.7000</Value>…
 *  Format gözlənilən kimi deyilsə xəta atılır (səssizcə boş nəticə yox). NOTE: real cavabla təsdiqlənməlidir. */
export function parseCbarXml(xml: string): { date: string; rates: CbarRate[] } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD/entity declarations are not allowed');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`Malformed CBAR XML: ${valid.err.msg}`);
  const root = (parser.parse(xml) as { ValCurs?: Record<string, any> }).ValCurs; // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(root?.['@_Date'] ?? ''));
  if (!root || !m) throw new Error('CBAR XML has no valid ValCurs/@Date');
  const rates: CbarRate[] = [];
  for (const t of root['ValType'] ?? []) {
    for (const v of t['Valute'] ?? []) {
      const code = String(v['@_Code'] ?? '');
      const value = String(v['Value'] ?? '');
      const nominal = String(v['Nominal'] ?? '1').replace(/\s/g, '');
      if (
        !/^[A-Z]{3}$/.test(code) ||
        !/^\d+(\.\d+)?$/.test(value) ||
        !/^\d+$/.test(nominal) ||
        Number(value) <= 0
      )
        throw new Error(`Invalid CBAR entry for ${code || '?'}`);
      rates.push({ currency: code, rate: value, nominal: Number(nominal) });
    }
  }
  if (rates.length === 0) throw new Error('CBAR XML contains no currencies');
  return { date: `${m[3]}-${m[2]}-${m[1]}`, rates };
}

export const cbarUrl = (isoDate: string) =>
  `https://www.cbar.az/currencies/${isoDate.slice(8, 10)}.${isoDate.slice(5, 7)}.${isoDate.slice(0, 4)}.xml`;
