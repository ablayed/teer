// @vitest-environment jsdom
import { EARLY_MENU_SCRIPT } from '@/components/orders/early-menu-intent';
import { LazyOrderActions } from '@/components/orders/lazy-order-actions';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Intention d'ouverture du menu « ⋯ » reçue AVANT l'hydratation (V4 bis).

function installScript() {
  // biome-ignore lint/security/noGlobalEval: le script de production est évalué tel quel, c'est l'objet du test.
  window.eval(EARLY_MENU_SCRIPT);
}

function addButton(id: string) {
  const button = document.createElement('button');
  button.setAttribute('data-early-menu', id);
  button.setAttribute('aria-label', 'Actions');
  button.setAttribute('data-early-idle-label', 'Actions');
  button.setAttribute('data-early-loading-label', 'Ouverture');
  button.setAttribute('data-early-failed-label', 'Réessayer');
  document.body.appendChild(button);
  return button;
}

describe('script de capture avant hydratation', () => {
  const added: Array<[string, EventListenerOrEventListenerObject, unknown]> = [];
  const realAdd = document.addEventListener.bind(document);

  beforeEach(() => {
    document.body.innerHTML = '';
    window.__earlyMenu = undefined;
    vi.useFakeTimers();
    // Le document persiste d'un test à l'autre : on retire les écouteurs posés par chaque installation.
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      added.push([type, listener, options]);
      realAdd(type, listener, options as AddEventListenerOptions);
    });
    installScript();
  });
  afterEach(() => {
    for (const [type, listener, options] of added.splice(0)) {
      document.removeEventListener(type, listener, options as AddEventListenerOptions);
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.__earlyMenu = undefined;
  });

  it('un appui donne un retour immédiat et garde l’intention', () => {
    const button = addButton('a');
    fireEvent.click(button);
    expect(button.getAttribute('data-early-state')).toBe('pending');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Ouverture');
    expect(window.__earlyMenu?.id).toBe('a');
  });

  it('garde AU PLUS UNE intention : la dernière remplace la précédente', () => {
    const a = addButton('a');
    const b = addButton('b');
    fireEvent.click(a);
    fireEvent.click(b);
    expect(window.__earlyMenu?.id).toBe('b');
    expect(a.getAttribute('data-early-state')).toBeNull();
    expect(a.getAttribute('aria-label')).toBe('Actions');
    expect(b.getAttribute('data-early-state')).toBe('pending');
  });

  it('un appui ailleurs que sur un bouton de menu ne fait rien', () => {
    const other = document.createElement('div');
    document.body.appendChild(other);
    fireEvent.click(other);
    expect(window.__earlyMenu?.id).toBeNull();
  });

  it('sans réponse après 15 s : état d’échec explicite qui dit quoi faire ; un nouvel appui réessaie', () => {
    const button = addButton('a');
    fireEvent.click(button);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(button.getAttribute('data-early-state')).toBe('failed');
    expect(button.getAttribute('aria-label')).toBe('Réessayer');
    expect(button.getAttribute('aria-busy')).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute('data-early-state')).toBe('pending');
    expect(window.__earlyMenu?.id).toBe('a');
  });

  it('après l’hydratation, plus aucune capture', () => {
    const button = addButton('a');
    if (window.__earlyMenu) window.__earlyMenu.hydrated = true;
    fireEvent.click(button);
    expect(button.getAttribute('data-early-state')).toBeNull();
    expect(window.__earlyMenu?.id).toBeNull();
  });

  it('aucun défaut d’état quand l’hydratation a lieu avant l’échéance (pas d’échec tardif)', () => {
    const button = addButton('a');
    fireEvent.click(button);
    if (window.__earlyMenu) {
      window.clearTimeout(window.__earlyMenu.timer);
      window.__earlyMenu.id = null;
      window.__earlyMenu.hydrated = true;
    }
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(button.getAttribute('data-early-state')).toBe('pending');
  });
});

describe('reprise par la carte à l’hydratation', () => {
  const props = (onActivate: () => void, orderId = 'a') => ({
    allowedActions: ['assigner'] as never,
    deliveryState: null,
    drivers: [],
    label: 'Actions',
    loadingLabel: 'Ouverture',
    mounted: false,
    onActivate,
    onBusyChange: () => undefined,
    orderId,
    orderState: 'open',
    phone: null,
    retryLabel: 'Réessayer',
    whatsappOrderData: {} as never,
  });
  const intent = (over: Partial<NonNullable<Window['__earlyMenu']>> = {}) => {
    window.__earlyMenu = {
      at: Date.now(),
      hydrated: false,
      id: 'a',
      path: `${window.location.pathname}${window.location.search}`,
      reset: () => undefined,
      timer: 0,
      ...over,
    };
  };

  afterEach(() => {
    cleanup();
    window.__earlyMenu = undefined;
  });

  it('l’intention de CETTE carte, fraîche, sur la même page : le menu est activé une fois', () => {
    intent();
    const onActivate = vi.fn();
    render(<LazyOrderActions {...props(onActivate)} />);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(window.__earlyMenu?.id).toBeNull();
  });

  it('l’intention d’une AUTRE carte n’active pas celle-ci', () => {
    intent({ id: 'autre' });
    const onActivate = vi.fn();
    render(<LazyOrderActions {...props(onActivate)} />);
    expect(onActivate).not.toHaveBeenCalled();
    expect(window.__earlyMenu?.id).toBe('autre');
  });

  it('une intention périmée est rejetée', () => {
    intent({ at: Date.now() - 16_000 });
    const onActivate = vi.fn();
    render(<LazyOrderActions {...props(onActivate)} />);
    expect(onActivate).not.toHaveBeenCalled();
    expect(window.__earlyMenu?.id).toBeNull();
  });

  it('une intention reçue sur une autre page est rejetée', () => {
    intent({ path: '/une/autre/page?vue=x' });
    const onActivate = vi.fn();
    render(<LazyOrderActions {...props(onActivate)} />);
    expect(onActivate).not.toHaveBeenCalled();
    expect(window.__earlyMenu?.id).toBeNull();
  });

  it('l’état visuel posé avant l’hydratation est nettoyé à la reprise', () => {
    const reset = vi.fn();
    intent({ reset });
    render(<LazyOrderActions {...props(() => undefined)} />);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('sans intention, rien n’est activé', () => {
    const onActivate = vi.fn();
    render(<LazyOrderActions {...props(onActivate)} />);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('le bouton porte ses étiquettes pour le script, et un état hydratation-sûr', () => {
    const { container } = render(<LazyOrderActions {...props(() => undefined)} />);
    const button = container.querySelector('[data-testid="order-actions-trigger"]');
    expect(button?.getAttribute('data-early-menu')).toBe('a');
    expect(button?.getAttribute('data-early-idle-label')).toBe('Actions');
    expect(button?.getAttribute('data-early-loading-label')).toBe('Ouverture');
    expect(button?.getAttribute('data-early-failed-label')).toBe('Réessayer');
  });
});
