import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner, NoopScanner, ScannerUnavailableError } from './antivirus.js';

/** clamd-i təqlid edən sadə TCP server: INSTREAM bayt-larını oxuyur, verilmiş cavabı qaytarır. */
function fakeClamd(reply: (received: Buffer) => string | null) {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d as Buffer]);
      if (buf.subarray(0, 6).toString() === 'zPING\0') {
        socket.write('PONG\0');
        return;
      }
      if (buf.subarray(0, 10).toString() === 'zINSTREAM\0') {
        // axının sonu: 4 sıfır bayt
        if (buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) {
          received.push(buf);
          const r = reply(buf);
          if (r !== null) socket.write(r);
        }
      }
    });
  });
  return new Promise<{ port: number; received: Buffer[]; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        resolve({ port, received, close: () => new Promise((r) => server.close(() => r())) });
      });
    },
  );
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('ClamAvScanner (clamd INSTREAM)', () => {
  it('reports a clean file', async () => {
    const srv = await fakeClamd(() => 'stream: OK\0');
    closers.push(srv.close);
    const scanner = new ClamAvScanner('127.0.0.1', srv.port);
    expect(await scanner.scan(Buffer.from('hello'))).toEqual({ clean: true });
  });

  it('reports an infection with the signature name', async () => {
    const srv = await fakeClamd(() => 'stream: Eicar-Test-Signature FOUND\0');
    closers.push(srv.close);
    const scanner = new ClamAvScanner('127.0.0.1', srv.port);
    expect(await scanner.scan(Buffer.from('X5O!P%@AP'))).toEqual({
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
  });

  it('frames the payload as length-prefixed chunks (large files span several chunks)', async () => {
    const srv = await fakeClamd(() => 'stream: OK\0');
    closers.push(srv.close);
    const scanner = new ClamAvScanner('127.0.0.1', srv.port);
    const data = Buffer.alloc(200_000, 7);
    await scanner.scan(data);
    const wire = srv.received[0]!;
    let off = 10; // "zINSTREAM\0"
    let total = 0;
    let chunks = 0;
    for (;;) {
      const len = wire.readUInt32BE(off);
      off += 4;
      if (len === 0) break;
      total += len;
      chunks++;
      off += len;
    }
    expect(total).toBe(200_000);
    expect(chunks).toBe(4); // 64 KiB parçalar
    expect(off).toBe(wire.length);
  });

  it('fails closed when clamd answers ERROR, is down, or times out', async () => {
    const err = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR\0');
    closers.push(err.close);
    await expect(
      new ClamAvScanner('127.0.0.1', err.port).scan(Buffer.from('x')),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);

    const down = await fakeClamd(() => 'stream: OK\0');
    const downPort = down.port;
    await down.close();
    await expect(
      new ClamAvScanner('127.0.0.1', downPort).scan(Buffer.from('x')),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);

    const silent = await fakeClamd(() => null);
    closers.push(silent.close);
    await expect(
      new ClamAvScanner('127.0.0.1', silent.port, 150).scan(Buffer.from('x')),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it('ping succeeds against a live clamd and fails otherwise', async () => {
    const srv = await fakeClamd(() => 'stream: OK\0');
    closers.push(srv.close);
    await expect(new ClamAvScanner('127.0.0.1', srv.port).ping()).resolves.toBeUndefined();
    const dead = await fakeClamd(() => null);
    const port = dead.port;
    await dead.close();
    await expect(new ClamAvScanner('127.0.0.1', port).ping()).rejects.toBeInstanceOf(
      ScannerUnavailableError,
    );
  });

  it('NoopScanner always says clean', async () => {
    expect(await new NoopScanner().scan()).toEqual({ clean: true });
  });
});
