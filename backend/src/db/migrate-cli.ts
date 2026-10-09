import { PgDb } from './client.js';
import { migrate } from './migrate.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = PgDb.connect(url, 2);
try {
  const res = await migrate(db);
  console.log(`applied: ${res.applied.join(', ') || '-'}; already applied: ${res.skipped.length}`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await db.close();
}
