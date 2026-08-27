/**
 * Phase F — Lot U1-F, §6 : « Données fictives uniquement. Aucun montant réel de marchand, aucune
 * requête vers des données de production. » Preuve statique : lit le fichier source de la page de
 * démo et échoue si un import ou un appel de lecture de données métier apparaît. La seule lecture
 * Supabase tolérée est `merchant_member` (garde de rôle propriétaire/manager, même mécanisme que
 * app/(app)/livreurs/page.tsx) — aucune autre table.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE_PATH = join(process.cwd(), 'app', '(app)', 'dev', 'finance-foundations', 'page.tsx');

function readPageSource(): string {
  return readFileSync(PAGE_PATH, 'utf8');
}

describe('page de démo finance-foundations — aucune source réelle', () => {
  it("n'importe aucune action serveur métier (lib/actions/*)", () => {
    const source = readPageSource();
    expect(source).not.toMatch(/from ['"]@\/lib\/actions\//);
  });

  it("n'utilise le client admin (bypass RLS) nulle part", () => {
    const source = readPageSource();
    expect(source).not.toMatch(/createSupabaseAdminClient/);
  });

  it('ne lit aucune table Supabase autre que merchant_member (garde de rôle)', () => {
    const source = readPageSource();
    const fromCalls = [...source.matchAll(/\.from\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

    expect(fromCalls).toEqual(['merchant_member']);
  });

  it('déclare ses données de démonstration inline (montants fictifs en dur dans le fichier)', () => {
    const source = readPageSource();
    expect(source).toMatch(/amountMinor:\s*408_000/);
  });
});
