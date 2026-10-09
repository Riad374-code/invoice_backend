import { describe, expect, it } from 'vitest';
import {
  DomainError,
  normalizeFolder,
  normalizeTags,
  sanitizeFileName,
  transitionExtraction,
} from './index.js';

describe('sanitizeFileName', () => {
  it('neutralises path traversal, separators and control characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('C:\\temp\\inv.pdf')).toBe('C__temp_inv.pdf');
    expect(sanitizeFileName('a\u0000b\nc.pdf')).toBe('a_b_c.pdf');
    expect(sanitizeFileName('  .hidden ')).toBe('hidden');
  });
  it('keeps Azerbaijani letters and caps the length', () => {
    expect(sanitizeFileName('qaimə-şəhər-çöl.pdf')).toBe('qaimə-şəhər-çöl.pdf');
    expect(sanitizeFileName('x'.repeat(400) + '.pdf').length).toBe(255);
  });
  it('rejects names that are empty after cleaning', () => {
    expect(() => sanitizeFileName('...')).toThrow(DomainError);
    expect(() => sanitizeFileName('   ')).toThrow(DomainError);
  });
});

describe('normalizeFolder', () => {
  it('normalises to an absolute path', () => {
    expect(normalizeFolder(undefined)).toBe('/');
    expect(normalizeFolder('')).toBe('/');
    expect(normalizeFolder('2026//Q1/')).toBe('/2026/Q1');
    expect(normalizeFolder('\\a\\b')).toBe('/a/b');
    expect(normalizeFolder('/a/./b')).toBe('/a/b');
  });
  it('rejects traversal and over-long paths', () => {
    expect(() => normalizeFolder('/a/../b')).toThrow(DomainError);
    expect(() => normalizeFolder('/' + 'x/'.repeat(300))).toThrow(DomainError);
    expect(() => normalizeFolder('a/b\u0000c')).toThrow(DomainError);
  });
});

describe('normalizeTags', () => {
  it('trims, lower-cases, de-duplicates and drops blanks', () => {
    expect(normalizeTags([' ƏDV ', 'edv', 'Q1', '', 'q1'])).toEqual(['ədv', 'edv', 'q1']);
  });
  it('enforces limits', () => {
    expect(() => normalizeTags(['x'.repeat(51)])).toThrow(DomainError);
    expect(() => normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow(DomainError);
  });
});

describe('extraction state machine (A-04)', () => {
  it('allows the pipeline and reindex transitions', () => {
    expect(transitionExtraction('pending', 'extracting')).toBe('extracting');
    expect(transitionExtraction('extracting', 'ready')).toBe('ready');
    expect(transitionExtraction('extracting', 'failed')).toBe('failed');
    expect(transitionExtraction('extracting', 'pending')).toBe('pending');
    expect(transitionExtraction('ready', 'pending')).toBe('pending');
    expect(transitionExtraction('failed', 'pending')).toBe('pending');
  });
  it('rejects everything else', () => {
    for (const [a, b] of [
      ['pending', 'ready'],
      ['pending', 'failed'],
      ['ready', 'extracting'],
      ['ready', 'failed'],
      ['failed', 'ready'],
      ['failed', 'extracting'],
    ] as const) {
      expect(() => transitionExtraction(a, b), `${a} -> ${b}`).toThrow(DomainError);
    }
  });
});
