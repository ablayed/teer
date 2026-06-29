'use client';

import { Button } from '@/components/ui/button';
import { DetailPanel } from '@/components/ui/detail-panel';
import { StatusBadge } from '@/components/ui/status-badge';
import { useState } from 'react';

export function DemoDetailPanel() {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Ouvrir panneau de démo
      </Button>
      <DetailPanel
        closeLabel="Fermer"
        open={open}
        title="Détail — Fatou Diallo"
        onClose={() => setOpen(false)}
      >
        <div className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text">Statut</span>
            <StatusBadge label="En livraison" tone="info" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text">Montant</span>
            <span className="text-sm text-muted">45 000 F CFA</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text">Téléphone</span>
            <span className="text-sm text-muted">+221 77 123 45 67</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text">Adresse</span>
            <span className="text-sm text-muted">Sacré-Cœur III, Dakar</span>
          </div>
        </div>
      </DetailPanel>
    </div>
  );
}
