import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production (PostgreSQL) schema', () => {
  it('is in sync with prisma/schema.prisma – run `npm run db:postgres:sync` after schema changes', () => {
    const source = readFileSync('prisma/schema.prisma', 'utf8');
    const generated = readFileSync('prisma/postgres/schema.prisma', 'utf8');
    const body = generated.split('\n').filter((l) => !l.startsWith('// GENERATED') && !l.startsWith('// Edit prisma/schema.prisma')).join('\n').trimStart();
    expect(body).toBe(source.replace('provider = "sqlite"', 'provider = "postgresql"'));
  });

  it('has migrations covering every model', () => {
    const dirs = readdirSync('prisma/postgres/migrations', { withFileTypes: true }).filter((d) => d.isDirectory());
    const sql = dirs.map((d) => readFileSync(`prisma/postgres/migrations/${d.name}/migration.sql`, 'utf8')).join('\n');
    const models = [...readFileSync('prisma/schema.prisma', 'utf8').matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
    for (const model of models) expect(sql, `no CREATE TABLE for ${model}`).toContain(`CREATE TABLE "${model}"`);
  });
});
