// k6 run -e BASE=http://localhost:8080 -e EMAIL=... -e PASSWORD=... load/k6-smoke.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '2m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'] },
};
const BASE = __ENV.BASE || 'http://localhost:8080';

export function setup() {
  const r = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email: __ENV.EMAIL, password: __ENV.PASSWORD }),
    {
      headers: {
        'content-type': 'application/json',
        origin: __ENV.ORIGIN || 'http://localhost:3000',
      },
    },
  );
  return { token: r.json('accessToken') };
}
export default function (d) {
  const h = { headers: { authorization: `Bearer ${d.token}` } };
  for (const p of [
    '/api/v1/me',
    '/api/v1/invoices',
    '/api/v1/vat/summary?from=2026-01-01&to=2026-12-31',
    '/api/v1/news',
  ]) {
    check(http.get(`${BASE}${p}`, h), { ok: (x) => x.status < 500 });
  }
  sleep(1);
}
