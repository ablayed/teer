import {
  RESPONSIVE_BAR_CHART_HORIZONTAL_THRESHOLD,
  buildShortCategoryLabels,
  resolveResponsiveBarChartPresentation,
  truncateChartLabel,
} from '@/components/charts/responsive-bar-chart';
import { describe, expect, it } from 'vitest';

describe('resolveResponsiveBarChartPresentation', () => {
  it('reste en rendu vertical pour un nombre compact de catégories', () => {
    expect(
      resolveResponsiveBarChartPresentation({ categoryCount: 3, isDesktop: false }).chartLayout,
    ).toBe('horizontal');
  });

  it('bascule en rendu horizontal au-delà du seuil validé', () => {
    expect(
      resolveResponsiveBarChartPresentation({
        categoryCount: RESPONSIVE_BAR_CHART_HORIZONTAL_THRESHOLD + 1,
        isDesktop: false,
      }).chartLayout,
    ).toBe('vertical');
  });

  it('tronque les labels longs avec une ellipse', () => {
    expect(truncateChartLabel('Ensemble wax indigo premium', 12)).toBe('Ensemble wa…');
  });

  it('désambiguïse les libellés tronqués du mode horizontal pour éviter les superpositions', () => {
    expect(
      buildShortCategoryLabels(
        [
          'Produit visuel extra long 1 - edition chaleureuse Dakar',
          'Produit visuel extra long 2 - edition chaleureuse Dakar',
        ],
        22,
      ),
    ).toEqual(['Produit visuel extra…', 'Produit visuel extr… 2']);
  });
});
