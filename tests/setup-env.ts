import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSupabaseHttpTarget } from '@/lib/security/supabase-target-policy';

function loadEnvFile(relativePath: string) {
  const filePath = resolve(process.cwd(), relativePath);

  if (!existsSync(filePath)) {
    return;
  }

  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue.startsWith("'") && rawValue.endsWith("'")
          ? rawValue.slice(1, -1)
          : rawValue;

    process.env[key] = value;
  }
}

loadEnvFile('.env.test');
loadEnvFile('.env.test.local');

const serverTarget = process.env.SUPABASE_URL;
const publicTarget = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (serverTarget || publicTarget) {
  assertSupabaseHttpTarget({
    target: serverTarget ?? publicTarget,
    variableName: serverTarget ? 'SUPABASE_URL' : 'NEXT_PUBLIC_SUPABASE_URL',
    context: 'test',
    serverTarget,
    publicTarget,
  });
}
