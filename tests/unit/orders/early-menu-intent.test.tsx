// @vitest-environment jsdom
import { EARLY_MENU_SCRIPT, EarlyMenuIntent } from '@/components/orders/early-menu-intent';
import { LazyOrderActions, useActiveOrderMenu } from '@/components/orders/lazy-order-actions';
import messages from '@/messages/fr.json';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-nonce': 'nonce-test' }) }));

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

  it('sans réponse après 15 s : état d’échec, message visible, et un nouvel appui RECHARGE la page', () => {
    const banner = document.createElement('div');
    banner.id = 'early-menu-failed';
    banner.hidden = true;
    document.body.appendChild(banner);
    const button = addButton('a');
    fireEvent.click(button);
    expect(banner.hidden).toBe(true);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(button.getAttribute('data-early-state')).toBe('failed');
    expect(button.getAttribute('aria-label')).toBe('Réessayer');
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect(banner.hidden).toBe(false);

    // Réarmer l'attente ne répare pas des scripts bloqués : l'appui suivant recharge la page.
    const reload = vi.fn();
    if (window.__earlyMenu) window.__earlyMenu.reload = reload;
    fireEvent.click(button);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('data-early-state')).toBe('failed');
  });

  it('le bouton « Recharger la page » du message recharge la page', () => {
    const banner = document.createElement('div');
    banner.id = 'early-menu-failed';
    const reloadButton = document.createElement('button');
    reloadButton.setAttribute('data-early-reload', '');
    banner.appendChild(reloadButton);
    document.body.appendChild(banner);
    const reload = vi.fn();
    if (window.__earlyMenu) window.__earlyMenu.reload = reload;
    fireEvent.click(reloadButton);
    expect(reload).toHaveBeenCalledTimes(1);
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
    reloadLabel: 'Recharger',
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
    expect(button?.getAttribute('data-early-failed-label')).toBe('Recharger');
  });
});

describe('rendu serveur : script, message d’échec, cas sans JavaScript', () => {
  it('porte le nonce, un message d’échec masqué et lisible, et masque les boutons sans JavaScript', async () => {
    const html = renderToStaticMarkup(
      await EarlyMenuIntent({ failedMessage: 'Message d’échec', reloadLabel: 'Recharger' }),
    );
    expect(html).toContain('nonce="nonce-test"');
    // Cas « JavaScript entièrement désactivé » : aucun script ne peut rien dire, les boutons inertes sont masqués.
    expect(html).toMatch(
      /<noscript><style>\[data-early-menu\]\{display:none\}<\/style><\/noscript>/,
    );
    // Cas « scripts applicatifs bloqués » : le script de secours affiche ce message.
    expect(html).toMatch(/id="early-menu-failed"/);
    expect(html).toMatch(/\shidden=""/);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Message d’échec');
    expect(html).toContain('data-early-reload');
    expect(html).toContain('Recharger');
  });

  it('les textes existent dans fr.json et disent de recharger la page', () => {
    const actions = messages.orders.actions;
    expect(actions.menuLoadFailedReload).toBe('Le menu n’a pas pu se charger. Rechargez la page.');
    expect(actions.menuReload).toBe('Recharger la page');
  });
});

describe('à l’hydratation : nettoyage de l’état posé avant', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    window.__earlyMenu = undefined;
  });

  function Host() {
    useActiveOrderMenu();
    return null;
  }

  it('retire le message d’échec, remet les boutons à neuf et marque l’hydratation', () => {
    const banner = document.createElement('div');
    banner.id = 'early-menu-failed';
    document.body.appendChild(banner);
    const stale = document.createElement('button');
    stale.setAttribute('data-early-state', 'failed');
    document.body.appendChild(stale);
    const reset = vi.fn();
    window.__earlyMenu = { at: 0, hydrated: false, id: null, path: '', reset, timer: 0 };

    render(<Host />);

    expect(window.__earlyMenu?.hydrated).toBe(true);
    expect(banner.hasAttribute('hidden')).toBe(true);
    expect(reset).toHaveBeenCalledWith(stale);
  });
});
