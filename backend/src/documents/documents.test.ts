import { describe, expect, it } from 'vitest';
import { ExtractorRegistry, NoExtractorError, detectDocument } from './index.js';

const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n');
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('x'),
]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const tiffLE = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
const zipWithXlsxMarkers = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('....[Content_Types].xml....xl/workbook.xml'),
]);
const plainZip = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('....hello.txt'),
]);
const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);

const kind = (b: Buffer, name: string, declared?: string) => {
  const r = detectDocument(b, name, declared);
  return r.ok ? r.doc.kind : `rejected: ${r.reason}`;
};

describe('detectDocument (magic bytes, not client claims)', () => {
  it('recognises the supported formats', () => {
    expect(kind(pdf, 'a.pdf')).toBe('pdf');
    expect(kind(png, 'a.png')).toBe('image');
    expect(kind(jpeg, 'a.jpg')).toBe('image');
    expect(kind(tiffLE, 'a.tif')).toBe('image');
    expect(kind(zipWithXlsxMarkers, 'book.xlsx')).toBe('spreadsheet');
    expect(kind(ole, 'old.xls')).toBe('spreadsheet');
    expect(kind(Buffer.from('a,b\n1,2\n'), 'x.csv')).toBe('csv');
    expect(kind(Buffer.from('hello'), 'x.txt')).toBe('text');
    expect(kind(Buffer.from('\uFEFF<?xml version="1.0"?><a/>'), 'x.xml')).toBe('xml');
  });

  it('ignores the extension for binary formats: a PDF named .png is still a PDF', () => {
    const r = detectDocument(pdf, 'scan.png');
    expect(r.ok && r.doc.kind).toBe('pdf');
  });

  it('rejects a declared type that contradicts the content', () => {
    expect(kind(pdf, 'a.pdf', 'image/png')).toMatch(/does not match/);
    expect(kind(png, 'a.png', 'application/pdf')).toMatch(/does not match/);
    expect(kind(Buffer.from('a,b'), 'x.csv', 'application/pdf')).toMatch(/does not match/);
  });

  it('accepts generic or compatible declared types, with parameters', () => {
    expect(kind(pdf, 'a.pdf', 'application/octet-stream')).toBe('pdf');
    expect(kind(pdf, 'a.pdf', 'application/pdf; charset=binary')).toBe('pdf');
    expect(kind(Buffer.from('a,b'), 'x.csv', 'application/vnd.ms-excel')).toBe('csv'); // Excel CSV
    expect(kind(Buffer.from('a,b'), 'x.csv', 'text/csv')).toBe('csv');
  });

  it('rejects executables, archives, scripts and empty files', () => {
    expect(kind(Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'setup.exe')).toMatch(/rejected/);
    expect(kind(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]), 'bin')).toMatch(/rejected/);
    expect(kind(plainZip, 'a.zip')).toMatch(/ZIP archives/);
    expect(kind(zipWithXlsxMarkers, 'book.zip')).toMatch(/ZIP archives/);
    expect(kind(Buffer.from('<script>alert(1)</script>'), 'x.html')).toMatch(/Unsupported/);
    expect(kind(Buffer.from('echo hi'), 'x.sh')).toMatch(/Unsupported/);
    expect(kind(Buffer.alloc(0), 'a.pdf')).toMatch(/empty/);
  });

  it('rejects non-UTF-8 text and NUL-containing "text"', () => {
    expect(kind(Buffer.from([0x61, 0xff, 0xfe, 0x62]), 'x.csv')).toMatch(/UTF-8/);
    expect(kind(Buffer.from('a\0b'), 'x.txt')).toMatch(/binary/);
  });

  it('rejects .xml that is not XML-looking', () => {
    expect(kind(Buffer.from('just words'), 'x.xml')).toMatch(/XML/);
  });
});

describe('ExtractorRegistry', () => {
  it('extracts text for csv/text/xml and strips the BOM', async () => {
    const reg = new ExtractorRegistry();
    const out = await reg.extract({
      buffer: Buffer.from('\uFEFFa,b\n1,2'),
      fileName: 'x.csv',
      mime: 'text/csv',
      kind: 'csv',
    });
    expect(out.text).toBe('a,b\n1,2');
    expect(out.layout).toMatchObject({ kind: 'csv', truncated: false });
  });
  it('throws NoExtractorError for kinds without an extractor, and allows registration', async () => {
    const reg = new ExtractorRegistry();
    const input = { buffer: pdf, fileName: 'a.pdf', mime: 'application/pdf', kind: 'pdf' as const };
    await expect(reg.extract(input)).rejects.toBeInstanceOf(NoExtractorError);
    reg.register('pdf', async () => ({ text: 'hi', layout: {} }));
    expect((await reg.extract(input)).text).toBe('hi');
  });
});
