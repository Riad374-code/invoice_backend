import { DomainError } from './errors.js';

export interface FileRecord {
  id: string;
  companyId: string;
  name: string;
  mime: string;
  size: number;
  folder: string;
  tags: string[];
  ownerId: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileVersion {
  id: string;
  companyId: string;
  fileId: string;
  versionNo: number;
  storageKey: string;
  sha256: string;
  size: number;
  mime: string;
  uploadedBy: string;
  createdAt: Date;
}

export const EXTRACTION_STATUSES = ['pending', 'extracting', 'ready', 'failed'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/** Sənəd növü (BACKEND.md §7 "detect type" mərhələsi). */
export const DOCUMENT_KINDS = [
  'xml', // B6: e-taxes.gov.az / 1C şablonları bu növü daha dəqiq alt-növlərə ayıracaq
  'pdf',
  'image',
  'spreadsheet', // xlsx / xls
  'csv',
  'text',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface FileExtraction {
  id: string;
  companyId: string;
  fileVersionId: string;
  detectedKind: DocumentKind | null;
  text: string | null;
  layoutJson: unknown;
  status: ExtractionStatus;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ALLOWED_EXTRACTION_TRANSITIONS: Record<ExtractionStatus, readonly ExtractionStatus[]> = {
  pending: ['extracting'],
  extracting: ['ready', 'failed', 'pending'], // pending: işçi çöküb, iş yenidən növbəyə qoyulur
  ready: ['pending'], // reindex
  failed: ['pending'], // reindex / retry
};

/** A-04: etibarsız keçid → 409 CONFLICT. */
export function transitionExtraction(
  from: ExtractionStatus,
  to: ExtractionStatus,
): ExtractionStatus {
  if (!ALLOWED_EXTRACTION_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `Disallowed extraction transition ${from} -> ${to}`,
    );
  }
  return to;
}

// Control simvolları, yol ayırıcıları və Windows-da qadağan olunmuş simvollar
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

/** Yüklənən faylın göstərilən adını təhlükəsiz hala gətirir (path traversal, control simvollar). */
export function sanitizeFileName(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(FORBIDDEN_NAME_CHARS, '_')
    .trim()
    .replace(/^\.+/, '') // gizli fayl / ".." qarşısı
    .trim();
  const name = cleaned.length > 255 ? cleaned.slice(cleaned.length - 255) : cleaned;
  if (!name) throw new DomainError('VALIDATION', 'File name is empty after sanitisation');
  return name;
}

/** `/a/b` formasına salır; `..`, boş seqment və 500 simvoldan uzun yolları rədd edir. */
export function normalizeFolder(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return '/';
  const segments = raw
    .replaceAll('\\', '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..' || FORBIDDEN_NAME_CHARS.test(s))) {
    FORBIDDEN_NAME_CHARS.lastIndex = 0;
    throw new DomainError('VALIDATION', 'Folder path contains forbidden segments');
  }
  FORBIDDEN_NAME_CHARS.lastIndex = 0;
  const folder = '/' + segments.join('/');
  if (folder.length > 500) throw new DomainError('VALIDATION', 'Folder path is too long');
  return folder;
}

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 50;

export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const tag = t.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw new DomainError('VALIDATION', `Tag exceeds ${MAX_TAG_LENGTH} characters`);
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS)
    throw new DomainError('VALIDATION', `At most ${MAX_TAGS} tags are allowed`);
  return out;
}
