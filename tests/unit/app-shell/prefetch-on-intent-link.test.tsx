// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrefetchOnIntentLink } from '@/components/app-shell/prefetch-on-intent-link';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Navigation du shell sans préchargement automatique (V7) : ni rendu serveur complet des pages, ni
// téléchargement de leur JS au chargement de /commandes ; le préchargement ne part que sur une intention.

const router = vi.hoisted(() => ({ prefetch: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    prefetch,
    ...rest
  }: {
    children: ReactNode;
    href: string;
    prefetch?: boolean | null;
  } & Record<string, unknown>) => (
    <a data-prefetch={String(prefetch)} href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe('lien de navigation à préchargement à l’intention', () => {
  afterEach(() => {
    cleanup();
    router.prefetch.mockClear();
  });

  it('ne précharge rien au rendu et désactive le préchargement automatique de Next', () => {
    render(<PrefetchOnIntentLink href="/s/1/clients">Clients</PrefetchOnIntentLink>);
    expect(screen.getByText('Clients').getAttribute('data-prefetch')).toBe('false');
    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it.each([
    ['focus clavier', (el: HTMLElement) => fireEvent.focus(el)],
    ['survol', (el: HTMLElement) => fireEvent.pointerEnter(el)],
    ['appui', (el: HTMLElement) => fireEvent.pointerDown(el)],
  ])('précharge sur %s, vers la bonne adresse', (_label, act) => {
    render(<PrefetchOnIntentLink href="/s/1/clients">Clients</PrefetchOnIntentLink>);
    act(screen.getByText('Clients'));
    expect(router.prefetch).toHaveBeenCalledTimes(1);
    expect(router.prefetch).toHaveBeenCalledWith('/s/1/clients');
  });

  it('conserve les gestionnaires de l’appelant', () => {
    const onFocus = vi.fn();
    const onPointerDown = vi.fn();
    const onPointerEnter = vi.fn();
    render(
      <PrefetchOnIntentLink
        href="/x"
        onFocus={onFocus}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
      >
        Lien
      </PrefetchOnIntentLink>,
    );
    const link = screen.getByText('Lien');
    fireEvent.focus(link);
    fireEvent.pointerEnter(link);
    fireEvent.pointerDown(link);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });
});

describe('barre de navigation et barre latérale', () => {
  const root = process.cwd();
  const files = ['components/app-shell/bottom-tab-nav.tsx', 'components/app-shell/sidebar.tsx'];

  it.each(files)('%s : plus de <Link> ni de prefetch explicite', (file) => {
    const source = readFileSync(join(root, file), 'utf8');
    expect(source).not.toMatch(/<Link[\s>]/);
    expect(source).not.toMatch(/\n\s+prefetch(=\{true\})?\s*\n/);
    expect(source).toContain('PrefetchOnIntentLink');
  });

  it('les trois liens de navigation passent par le lien à l’intention', () => {
    const count = files
      .map((file) => readFileSync(join(root, file), 'utf8'))
      .reduce((n, source) => n + (source.match(/<PrefetchOnIntentLink[\s>]/g)?.length ?? 0), 0);
    expect(count).toBe(3);
  });

  it('le lien à l’intention ne reprogramme aucun préchargement après load (aucune minuterie)', () => {
    const source = readFileSync(
      join(root, 'components/app-shell/prefetch-on-intent-link.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/setTimeout|setInterval|requestIdleCallback|useEffect/);
    expect(source).toContain('prefetch={false}');
  });
});
