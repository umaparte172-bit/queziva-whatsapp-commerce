/**
 * Creates an admin login, or resets the password of an existing one.
 *
 *   npm run admin:create -- <email> <password> [name]
 */
import { hashPassword } from '../src/lib/auth.js';
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const [emailArg, password, ...nameParts] = process.argv.slice(2);
  if (!emailArg || !password) {
    console.error('Usage: npm run admin:create -- <email> <password> [name]');
    process.exitCode = 1;
    return;
  }
  const email = emailArg.trim().toLowerCase();
  const name = nameParts.join(' ') || 'Queziva Admin';
  const passwordHash = await hashPassword(password);

  const admin = await prisma.adminUser.upsert({
    where: { email },
    create: { email, name, passwordHash },
    update: { passwordHash, active: true, ...(nameParts.length ? { name } : {}) },
  });
  console.log(`Admin ready: ${admin.email} (${admin.name})`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
