import { randomUUID } from 'node:crypto';

export interface UploadFile {
  name: string;
  content: Buffer | string;
  /** Müştərinin bəyan etdiyi Content-Type (default: application/octet-stream). */
  type?: string;
  field?: string;
}

/** `app.inject` üçün multipart/form-data gövdəsi. */
export function multipart(file: UploadFile | null, fields: Record<string, string> = {}) {
  const boundary = `----vitest${randomUUID().replaceAll('-', '')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
        'utf8',
      ),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
        'utf8',
      ),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'),
      Buffer.from('\r\n', 'utf8'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// Minimal etibarlı nümunələr (magic byte-lar real formatlarla eynidir)
export const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);
export const CSV_TEXT =
  'number,date,net,vat\nINV-1,2026-01-05,100.00,18.00\nINV-2,2026-01-06,50.00,9.00\n';
