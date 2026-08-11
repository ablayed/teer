import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = '.next/static';
const forbiddenNames = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  'CRON_SECRET',
  'GROQ_API_KEY',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_TOKEN_ENCRYPTION_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'BACKUP_ENCRYPTION_KEY',
];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

if (!existsSync(root)) {
  process.stderr.write('S1D-4 bundle check failed: production build is missing\n');
  process.exit(2);
}

for (const file of files(root)) {
  const content = readFileSync(file, 'utf8');
  if (forbiddenNames.some((name) => content.includes(name))) {
    process.stderr.write(
      'S1D-4 bundle check failed: server-only configuration reached the browser\n',
    );
    process.exit(1);
  }
}

process.stdout.write('S1D-4 bundle check passed\n');
