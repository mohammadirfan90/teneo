// scripts/verify-db-shape.ts
// Unit smoke test for the helper that decides whether DATABASE_URL needs TLS.
// Doesn't open a connection — just exercises shouldUseTls.

import { shouldUseTls } from '../src/lib/db-shape';

interface Case {
  name: string;
  url: string;
  expect: boolean;
}

const cases: Case[] = [
  { name: 'docker localhost', url: 'postgresql://u:p@localhost:55432/d', expect: false },
  { name: 'docker 127.0.0.1', url: 'postgresql://u:p@127.0.0.1:55432/d', expect: false },
  { name: 'docker ::1', url: 'postgresql://u:p@[::1]:55432/d', expect: false },
  {
    name: 'neon',
    url: 'postgresql://u:p@ep-xxx.region.aws.neon.tech/d?sslmode=require',
    expect: true,
  },
  {
    name: 'supabase direct',
    url: 'postgresql://postgres:p@db.xxx.supabase.co:5432/postgres',
    expect: true,
  },
  {
    name: 'supabase pooler',
    url: 'postgresql://postgres:p@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true',
    expect: true,
  },
  { name: 'render', url: 'postgresql://u:p@render-host.render.com/d', expect: true },
];

let failed = 0;
for (const c of cases) {
  const got = shouldUseTls(c.url);
  const ok = got === c.expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  → ${got}`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.error(`${failed} case(s) failed`);
  process.exit(1);
}
console.log(`All ${cases.length} cases passed`);
