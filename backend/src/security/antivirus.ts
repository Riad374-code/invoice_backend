import net from 'node:net';

export type ScanResult = { clean: true } | { clean: false; signature: string };

/** Skaner əlçatmazdırsa fayl QƏBUL EDİLMİR (fail-closed) → 503. */
export class ScannerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScannerUnavailableError';
  }
}

export interface AntivirusScanner {
  scan(data: Buffer): Promise<ScanResult>;
  ping(): Promise<void>;
}

/** Antivirus söndürülüb (yalnız dev/test və ya açıq-aşkar CLAMAV_DISABLED=true). */
export class NoopScanner implements AntivirusScanner {
  async scan(): Promise<ScanResult> {
    return { clean: true };
  }
  async ping(): Promise<void> {}
}

const CHUNK = 64 * 1024;

/** clamd `INSTREAM` protokolu (TCP). */
export class ClamAvScanner implements AntivirusScanner {
  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 30_000,
  ) {}

  private session<T>(
    onConnect: (socket: net.Socket, done: (v: T) => void, fail: (e: Error) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new ScannerUnavailableError(`ClamAV unavailable: ${err.message}`, { cause: err }));
      };
      const done = (v: T) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(v);
      };
      socket.setTimeout(this.timeoutMs, () => fail(new Error('timeout')));
      socket.on('error', fail);
      socket.on('connect', () => onConnect(socket, done, fail));
    });
  }

  async ping(): Promise<void> {
    const reply = await this.session<string>((socket, done, fail) => {
      let buf = '';
      socket.write('zPING\0');
      socket.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('\0') || buf.includes('\n')) done(buf.replace(/[\0\n]+$/, ''));
      });
      socket.on('end', () => (buf ? done(buf) : fail(new Error('connection closed'))));
    });
    if (reply !== 'PONG')
      throw new ScannerUnavailableError(`Unexpected ClamAV PING reply: ${reply}`);
  }

  scan(data: Buffer): Promise<ScanResult> {
    return this.session<ScanResult>((socket, done, fail) => {
      let buf = '';
      const finish = () => {
        const reply = buf.replace(/[\0\n]+$/, '').trim();
        if (reply.endsWith('OK')) return done({ clean: true });
        const found = /^stream:\s*(.+)\s+FOUND$/.exec(reply);
        if (found?.[1]) return done({ clean: false, signature: found[1] });
        fail(new Error(`unexpected reply: ${reply || '(empty)'}`));
      };
      socket.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('\0') || buf.includes('\n')) finish();
      });
      socket.on('end', finish);

      socket.write('zINSTREAM\0');
      for (let off = 0; off < data.length; off += CHUNK) {
        const chunk = data.subarray(off, off + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        socket.write(len);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4)); // 0-uzunluq = axının sonu
    });
  }
}
