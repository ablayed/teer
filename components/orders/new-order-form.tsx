'use client';

import { createManualOrderAction } from '@/lib/actions/orders';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const sourceOptions = [
  { value: 'manual', label: 'Manuel' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'facebook', label: 'Facebook' },
] as const;

export function NewOrderForm() {
  const router = useRouter();
  const createOrder = useAction(createManualOrderAction);
  const [isOpen, setIsOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState<(typeof sourceOptions)[number]['value']>('manual');
  const [productName, setProductName] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [address, setAddress] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    const result = createOrder.result.data;

    if (!result) {
      return;
    }

    if (result.ok) {
      setFeedback('Commande creee.');
      setCustomerName('');
      setPhone('');
      setSource('manual');
      setProductName('');
      setTotalAmount('');
      setAddress('');
      setIsOpen(false);
      router.replace('/commandes');
      router.refresh();
      return;
    }

    setFeedback(result.message);
  }, [createOrder.result.data, router]);

  function submit() {
    const parsedAmount = Number.parseFloat(totalAmount);

    setFeedback(null);
    createOrder.execute({
      customerName,
      phone,
      source,
      productName,
      totalAmount: Number.isFinite(parsedAmount) ? parsedAmount : Number.NaN,
      ...(address.trim() ? { address: address.trim() } : {}),
    });
  }

  return (
    <div className="w-full max-w-xl rounded-lg border border-border bg-surface p-4 shadow-1">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Nouvelle commande</p>
          <p className="text-sm text-muted">
            Creation manuelle pour telephone, produit et montant.
          </p>
        </div>
        <button
          className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover"
          onClick={() => setIsOpen((value) => !value)}
          type="button"
        >
          {isOpen ? 'Fermer' : 'Nouvelle commande'}
        </button>
      </div>

      {isOpen ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium">Nom client</span>
            <input
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder="Ex : Awa Diop"
              type="text"
              value={customerName}
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium">Telephone</span>
            <input
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+221 77 123 45 67"
              type="tel"
              value={phone}
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium">Source</span>
            <select
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              onChange={(event) =>
                setSource(event.target.value as (typeof sourceOptions)[number]['value'])
              }
              value={source}
            >
              {sourceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium">Produit</span>
            <input
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              onChange={(event) => setProductName(event.target.value)}
              placeholder="Ex : Sac cuir"
              type="text"
              value={productName}
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium">Montant</span>
            <input
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              min="0"
              onChange={(event) => setTotalAmount(event.target.value)}
              placeholder="12500"
              step="0.01"
              type="number"
              value={totalAmount}
            />
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium">Adresse (optionnel)</span>
            <textarea
              className="min-h-24 w-full rounded-lg border border-border bg-canvas px-3 py-2"
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Quartier, repere, ville"
              value={address}
            />
          </label>

          <div className="space-y-3 md:col-span-2">
            <button
              className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
              disabled={createOrder.isExecuting}
              onClick={submit}
              type="button"
            >
              Creer la commande
            </button>
          </div>
        </div>
      ) : null}
      {feedback ? <p className="mt-4 text-sm text-muted">{feedback}</p> : null}
    </div>
  );
}
