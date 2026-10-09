import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * e-qaimə XML şablon parser-i (AI yoxdur, deterministik). Şablonlar VERSİYALIDIR: yeni export formatı
 * = yeni şablon, köhnələr toxunulmaz qalır (köhnə fayllar yenidən import oluna bilsin).
 * NOTE: `etaxes-v1` sxemi aşağıda sənədləşdirilib; real e-taxes.gov.az export nümunələri ilə təsdiqlənməlidir
 * və uyğunsuzluq halında YENİ şablon versiyası əlavə olunmalıdır.
 */
export interface ParsedParty {
  name: string;
  voen: string | null;
  isVatPayer: boolean | null;
}
export interface ParsedLine {
  description: string;
  qty: string;
  unitPrice: string;
  vatRateCode: string;
  net: string;
  vat: string;
}
export interface ParsedInvoice {
  templateVersion: string;
  number: string;
  issueDate: string;
  currency: string;
  seller: ParsedParty;
  buyer: ParsedParty;
  lines: ParsedLine[];
  net: string | null;
  vat: string | null;
  gross: string | null;
}

export class InvoiceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceParseError';
  }
}

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // məbləğlər string qalır — float-a çevrilmir
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false, // XXE / billion-laughs qarşısı
  isArray: (name) => name === 'item',
});

const text = (n: unknown): string | null => {
  if (typeof n === 'string') return n.trim() === '' ? null : n.trim();
  if (n && typeof n === 'object' && '#text' in (n as Node)) return text((n as Node)['#text']);
  return null;
};
const req = (n: unknown, what: string): string => {
  const v = text(n);
  if (v === null) throw new InvoiceParseError(`Missing required element <${what}>`);
  return v;
};
const bool = (v: string | null): boolean | null => (v === null ? null : /^(true|1|yes)$/i.test(v));

function party(n: unknown, role: string): ParsedParty {
  if (!n || typeof n !== 'object') throw new InvoiceParseError(`Missing <${role}>`);
  const o = n as Node;
  return {
    name: req(o['name'], `${role}/name`),
    voen: text(o['voen']),
    isVatPayer: bool(text(o['vatPayer'])),
  };
}

/** etaxes-v1: <invoice version="1"><number/><date/><currency/><seller>…</seller><buyer>…</buyer><items><item>…</item></items><totals>…</totals></invoice> */
function parseEtaxesV1(root: Node): ParsedInvoice {
  const items = (root['items'] as Node | undefined)?.['item'] as Node[] | undefined;
  if (!items || items.length === 0) throw new InvoiceParseError('Invoice has no <item> elements');
  const lines = items.map((it, i) => {
    const vatRate = it['vatRate'];
    const code =
      typeof vatRate === 'object' && vatRate ? text((vatRate as Node)['@_code']) : text(vatRate);
    return {
      description: req(it['name'], `item[${i + 1}]/name`),
      qty: req(it['qty'], `item[${i + 1}]/qty`),
      unitPrice: req(it['price'], `item[${i + 1}]/price`),
      vatRateCode:
        code ??
        (() => {
          throw new InvoiceParseError(`Missing vat rate code in item[${i + 1}]`);
        })(),
      net: req(it['net'], `item[${i + 1}]/net`),
      vat: req(it['vat'], `item[${i + 1}]/vat`),
    };
  });
  const totals = (root['totals'] as Node | undefined) ?? {};
  return {
    templateVersion: 'etaxes-v1',
    number: req(root['number'], 'number'),
    issueDate: req(root['date'], 'date'),
    currency: text(root['currency']) ?? 'AZN',
    seller: party(root['seller'], 'seller'),
    buyer: party(root['buyer'], 'buyer'),
    lines,
    net: text(totals['net']),
    vat: text(totals['vat']),
    gross: text(totals['gross']),
  };
}

const TEMPLATES: Array<{
  id: string;
  matches: (root: Node) => boolean;
  parse: (root: Node) => ParsedInvoice;
}> = [
  {
    id: 'etaxes-v1',
    matches: (r) => typeof r['seller'] !== 'undefined' && typeof r['items'] !== 'undefined',
    parse: parseEtaxesV1,
  },
];

/** Şablonu avtomatik seçir; heç biri uyğun gəlmirsə `null` (başqa növ XML). Pozuq XML → InvoiceParseError. */
export function parseInvoiceXml(xml: string): ParsedInvoice | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new InvoiceParseError('DTD/entity declarations are not allowed');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new InvoiceParseError(`Malformed XML: ${valid.err.msg}`);
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    throw new InvoiceParseError(`Malformed XML: ${(e as Error).message}`);
  }
  const root = doc['invoice'] as Node | undefined;
  if (!root || typeof root !== 'object') return null;
  const tpl = TEMPLATES.find((t) => t.matches(root));
  return tpl ? tpl.parse(root) : null;
}
