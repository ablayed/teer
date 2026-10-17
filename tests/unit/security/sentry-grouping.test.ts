import { sanitizeSentryEvent } from '@/lib/security/telemetry-sanitize';
import { describe, expect, it } from 'vitest';

const SECRET_TEXT = 'Commande de Awa Diop, +221 77 123 45 67, awa@example.com';

function event(overrides: Record<string, unknown>) {
  return {
    level: 'error',
    exception: {
      values: [
        {
          type: 'TypeError',
          value: SECRET_TEXT,
          mechanism: { type: 'generic', handled: false },
          stacktrace: {
            frames: [
              {
                filename:
                  'https://www.teerafrik.com/_next/static/chunks/app/page-abc123.js?token=secret',
                function: 'OrderCard.onClick',
                lineno: 12,
                colno: 34,
                in_app: true,
                context_line: `const note = "${SECRET_TEXT}"`,
                vars: { phone: '+221771234567' },
              },
            ],
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('Sentry : groupement sans donnée client', () => {
  it('deux erreurs différentes gardent des empreintes différentes (type, fonction, fichier, ligne)', () => {
    const a = sanitizeSentryEvent(event({}));
    const b = sanitizeSentryEvent(
      event({
        exception: {
          values: [
            {
              type: 'RangeError',
              value: SECRET_TEXT,
              stacktrace: {
                frames: [
                  { filename: '/_next/static/chunks/other.js', function: 'parseAmount', lineno: 7 },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(JSON.stringify(a.exception)).not.toBe(JSON.stringify(b.exception));
    expect(a.exception?.values?.[0]?.type).toBe('TypeError');
    expect(b.exception?.values?.[0]?.type).toBe('RangeError');
  });

  it('conserve fichier (sans origine ni paramètres), fonction, position et mécanisme', () => {
    const frame = sanitizeSentryEvent(event({})).exception?.values?.[0] as {
      stacktrace: { frames: Record<string, unknown>[] };
      mechanism: unknown;
    };
    expect(frame.stacktrace.frames[0]).toEqual({
      filename: '/_next/static/chunks/app/page-abc123.js',
      function: 'OrderCard.onClick',
      lineno: 12,
      colno: 34,
      in_app: true,
    });
    expect(frame.mechanism).toEqual({ type: 'generic', handled: false });
  });

  it('aucune donnée client ne sort : texte libre, contexte source et variables effacés', () => {
    const out = JSON.stringify(
      sanitizeSentryEvent(
        event({ message: SECRET_TEXT, user: { ip_address: '1.2.3.4', email: 'a@b.c' } }),
      ),
    );
    for (const leak of [
      'Awa',
      'Diop',
      '221',
      'example.com',
      'secret',
      'context_line',
      'vars',
      '1.2.3.4',
      'a@b.c',
    ]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('redacted_error');
    // Seule l'adresse IP explicitement nulle subsiste : aucune identité, aucune déduction d'adresse.
    expect(out).toContain('"user":{"ip_address":null}');
  });

  it('un code d’erreur métier de la liste blanche est conservé, un texte libre non', () => {
    const code = sanitizeSentryEvent(
      event({ exception: { values: [{ type: 'Error', value: 'UNEXPECTED_ERROR' }] } }),
    );
    expect(code.exception?.values?.[0]?.value).toBe('UNEXPECTED_ERROR');
    const free = sanitizeSentryEvent(
      event({ exception: { values: [{ type: 'Error', value: 'Unexpected Error pour Awa' }] } }),
    );
    expect(free.exception?.values?.[0]?.value).toBe('redacted_error');
  });

  it('rejette une fonction ou un fichier qui ressemble à une donnée', () => {
    const out = sanitizeSentryEvent(
      event({
        exception: {
          values: [
            {
              type: 'Error',
              stacktrace: {
                frames: [{ filename: '/a/awa@example.com.js', function: 'Awa Diop 0612345678!' }],
              },
            },
          ],
        },
      }),
    );
    expect(
      (out.exception?.values?.[0] as { stacktrace: { frames: unknown[] } }).stacktrace.frames[0],
    ).toEqual({});
  });
});
