import { writeFile } from 'node:fs/promises';
import { buildApp } from './app.js';
import { testConfig } from './config.js';
import { PgliteDb } from './db/index.js';
import { NoopScanner } from './security/antivirus.js';
import { MemoryStorage } from './storage/index.js';

// DB-yə toxunmadan sxemi çıxarır (yalnız route-lar yüklənir).
const db = await PgliteDb.create();
const app = await buildApp({
  config: testConfig(),
  db,
  storage: new MemoryStorage(),
  scanner: new NoopScanner(),
});
await app.ready();
const out = new URL('../openapi.json', import.meta.url);
await writeFile(out, JSON.stringify(app.swagger(), null, 2) + '\n');
console.log(`OpenAPI written to ${out.pathname}`);
await app.close();
await db.close();
