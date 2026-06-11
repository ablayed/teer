import { buildCspHeader, cspRegimeForPath } from '@/lib/security/csp';
import { describe, expect, it } from 'vitest';

describe('cspRegimeForPath', () => {
  it('classe les pages publiques prérendues en régime « static »', () => {
    for (const p of [
      '/',
      '/connexion',
      '/confidentialite',
      '/conditions',
      '/dpa',
      '/mentions-legales',
    ]) {
      expect(cspRegimeForPath(p)).toBe('static');
    }
  });

  it('classe tout le reste en régime « app » strict (défaut sécuritaire)', () => {
    for (const p of [
      '/commandes',
      '/commandes/abc-123',
      '/clients',
      '/tableau',
      '/assistant',
      '/onboarding',
      '/reacceptation',
      '/invitation/accept',
      '/route-inconnue',
    ]) {
      expect(cspRegimeForPath(p)).toBe('app');
    }
  });
});

describe('buildCspHeader — régime app (nonce strict)', () => {
  const csp = buildCspHeader({ regime: 'app', isDev: false, nonce: 'NONCE_TEST' });

  it('porte le nonce et strict-dynamic, et JAMAIS unsafe-inline sur script-src', () => {
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toContain("'nonce-NONCE_TEST'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('verrouille les directives de base', () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('émet upgrade-insecure-requests en prod, JAMAIS en dev (WebKit upgrade http://localhost)', () => {
    expect(csp).toContain('upgrade-insecure-requests');
    const dev = buildCspHeader({ regime: 'app', isDev: true, nonce: 'N' });
    expect(dev).not.toContain('upgrade-insecure-requests');
    // idem régime statique
    expect(buildCspHeader({ regime: 'static', isDev: false })).toContain(
      'upgrade-insecure-requests',
    );
    expect(buildCspHeader({ regime: 'static', isDev: true })).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it("n'expose pas 'unsafe-eval' en production", () => {
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("autorise 'unsafe-eval' et ws: uniquement en dev (React Refresh / HMR)", () => {
    const dev = buildCspHeader({ regime: 'app', isDev: true, nonce: 'N' });
    const scriptSrc = dev.split('; ').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(dev.split('; ').find((d) => d.startsWith('connect-src '))).toContain('ws:');
  });
});

describe('buildCspHeader — régime static (pages publiques)', () => {
  const csp = buildCspHeader({ regime: 'static', isDev: false });

  it("autorise 'unsafe-inline' sur script-src (scripts inline flight RSC) mais pas strict-dynamic ni nonce", () => {
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toBe("script-src 'self' 'unsafe-inline'");
  });

  it('garde connect-src minimal (aucun analytics sur les pages publiques)', () => {
    expect(csp).toContain("connect-src 'self'");
  });

  it('conserve les mêmes verrous de base que le régime app', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});
