import {
  RESPONSIVE_BAR_CHART_HORIZONTAL_THRESHOLD,
  buildShortCategoryLabels,
  resolveResponsiveBarChartPresentation,
  truncateChartLabel,
} from '@/components/charts/responsive-bar-chart';
import { describe, expect, it } from 'vitest';

describe('resolveResponsiveBarChartPresentation', () => {
  it('reste en rendu vertical pour un nombre compact de categories', () => {
    const presentation = resolveResponsiveBarChartPresentation({
      categoryCount: 3,
      isDesktop: true,
    });

    expect(presentation.chartLayout).toBe('horizontal');
    expect(presentation.maxBarSize).toBe(120);
  });

  it('bascule en rendu horizontal au-dela du seuil valide', () => {
    expect(
      resolveResponsiveBarChartPresentation({
        categoryCount: RESPONSIVE_BAR_CHART_HORIZONTAL_THRESHOLD + 1,
        isDesktop: false,
      }).chartLayout,
    ).toBe('vertical');
  });

  it('tronque les labels longs avec une ellipse', () => {
    expect(truncateChartLabel('Ensemble wax indigo premium', 12)).toBe('Ensemble wa\u2026');
  });

  it('desambigue les libelles tronques du mode horizontal pour eviter les superpositions', () => {
    expect(
      buildShortCategoryLabels(
        [
          'Produit visuel extra long 1 - edition chaleureuse Dakar',
          'Produit visuel extra long 2 - edition chaleureuse Dakar',
        ],
        22,
      ),
    ).toEqual(['Produit visuel extra\u2026', 'Produit visuel extr\u2026 2']);
  });
});
