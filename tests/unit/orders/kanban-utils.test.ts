import {
  getKanbanColumnKey,
  getKanbanDropTarget,
  isKanbanTransitionAllowed,
} from '@/components/orders/kanban/kanban-utils';
import { describe, expect, it, vi } from 'vitest';

describe('kanban-utils', () => {
  it('mappe les 8 statuts COD vers les 6 colonnes Kanban', () => {
    expect(getKanbanColumnKey('A_APPELER')).toBe('A_APPELER');
    expect(getKanbanColumnKey('TENTEE')).toBe('TENTEE');
    expect(getKanbanColumnKey('CONFIRMEE')).toBe('CONFIRMEE');
    expect(getKanbanColumnKey('PROGRAMMEE')).toBe('EN_LIVRAISON');
    expect(getKanbanColumnKey('EN_LIVRAISON')).toBe('EN_LIVRAISON');
    expect(getKanbanColumnKey('LIVREE')).toBe('LIVREE');
    expect(getKanbanColumnKey('REFUSEE')).toBe('ANNULEE_REFUSEE');
    expect(getKanbanColumnKey('ANNULEE')).toBe('ANNULEE_REFUSEE');
  });

  it('calcule le statut cible des colonnes fusionnées au drop', () => {
    expect(getKanbanDropTarget('A_APPELER')).toBe('A_APPELER');
    expect(getKanbanDropTarget('TENTEE')).toBe('TENTEE');
    expect(getKanbanDropTarget('CONFIRMEE')).toBe('CONFIRMEE');
    expect(getKanbanDropTarget('EN_LIVRAISON')).toBe('PROGRAMMEE');
    expect(getKanbanDropTarget('LIVREE')).toBe('LIVREE');
    expect(getKanbanDropTarget('ANNULEE_REFUSEE')).toBe('ANNULEE');
  });

  it('rejette une transition illégale avant toute mutation', () => {
    const canTransition = vi.fn(() => false);

    expect(isKanbanTransitionAllowed('CONFIRMEE', 'LIVREE', canTransition)).toBe(false);
    expect(canTransition).toHaveBeenCalledWith('CONFIRMEE', 'LIVREE');
  });
});
