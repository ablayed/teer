// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RenderNowProvider, useRenderNow } from '@/components/orders/render-now';
import { formatDateGroupLabel, formatDateRelative } from '@/lib/format/date';
import { act, cleanup, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Horloge déterministe du rendu (V2) : le rendu serveur et le premier rendu du navigateur utilisent
// le même instant, fourni par le serveur ; l'heure réelle n'est lue qu'après le montage, une fois.

const ROOT = resolve(import.meta.dirname, '../../..');
const SERVER_NOW = '2026-10-14T12:00:00.000Z';
const ORDER_DATE = '2026-10-14T11:55:00.000Z';

function Probe() {
  const now = useRenderNow();
  return (
    <p>
      {formatDateRelative(ORDER_DATE, now)} | {formatDateGroupLabel(ORDER_DATE, now)}
    </p>
  );
}

function Tree() {
  return (
    <RenderNowProvider serverNow={SERVER_NOW}>
      <Probe />
    </RenderNowProvider>
  );
}

describe('instant de rendu fourni par le serveur', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('le HTML serveur ne dépend pas de l’heure réelle', () => {
    vi.setSystemTime(new Date('2026-10-14T12:00:05.000Z'));
    const first = renderToString(<Tree />);
    vi.setSystemTime(new Date('2026-10-14T13:47:00.000Z'));
    const second = renderToString(<Tree />);

    expect(second).toBe(first);
    expect(first).toContain('il y a 5 min');
    expect(first).toMatch(/Aujourd(&#x27;|')hui/);
  });

  it('le premier rendu du navigateur est celui du serveur, même si l’heure a avancé', () => {
    vi.setSystemTime(new Date('2026-10-14T12:00:05.000Z'));
    const serverHtml = renderToString(<Tree />);
    // Le navigateur hydrate 40 minutes plus tard : son premier rendu (avant effets) doit
    // correspondre au HTML reçu, sinon React signale un écart d'hydratation.
    vi.setSystemTime(new Date('2026-10-14T12:40:00.000Z'));
    const beforeEffects = renderToString(<Tree />);

    expect(beforeEffects).toBe(serverHtml);
  });

  it('après le montage, l’heure réelle corrige les libellés relatifs', () => {
    vi.setSystemTime(new Date('2026-10-14T12:40:00.000Z'));
    const { container } = render(<Tree />);

    expect(container.textContent).toContain('il y a 45 min');
  });

  it('une seule lecture de l’heure réelle : aucune minuterie, aucun polling', () => {
    vi.setSystemTime(new Date('2026-10-14T12:40:00.000Z'));
    const { container } = render(<Tree />);
    const afterMount = container.textContent;

    act(() => {
      vi.advanceTimersByTime(30 * 60_000);
    });

    expect(container.textContent).toBe(afterMount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hors fournisseur : l’heure courante, comme avant', () => {
    vi.setSystemTime(new Date('2026-10-14T12:30:00.000Z'));
    const { container } = render(<Probe />);

    expect(container.textContent).toContain('il y a 35 min');
  });
});

describe('formatDateRelative avec un instant explicite', () => {
  it('ne lit pas Date.now()', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    expect(formatDateRelative(ORDER_DATE, new Date(SERVER_NOW))).toBe('il y a 5 min');
    expect(formatDateRelative(ORDER_DATE, Date.parse(SERVER_NOW))).toBe('il y a 5 min');
    vi.useRealTimers();
  });
});

describe('les écrans de commandes utilisent l’instant du rendu', () => {
  it.each(['components/orders/orders-page-loader.tsx', 'components/orders/kanban/KanbanCard.tsx'])(
    '%s : useRenderNow, et aucun formatDateRelative sans instant',
    (file) => {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      expect(source).toContain('useRenderNow()');
      const calls = [...source.matchAll(/formatDateRelative\(([^)]*)\)/g)].map((m) => m[1] ?? '');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((args) => args.includes(','))).toBe(true);
    },
  );

  it('la page enveloppe l’espace de travail dans le fournisseur', () => {
    const page = readFileSync(resolve(ROOT, 'app/(app)/commandes/page.tsx'), 'utf8');
    expect(page).toContain('<RenderNowProvider serverNow=');
  });
});
