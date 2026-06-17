'use client';

import {
  createExpenseAction,
  deleteExpenseAction,
  updateExpenseAction,
} from '@/lib/actions/expenses';
import { formatMoney } from '@/lib/format/fcfa';
import { useTranslations } from 'next-intl';
import { useCallback, useState, useTransition } from 'react';

type Category = {
  id: string;
  code: string;
  label_fr: string;
  syscohada_account: string | null;
  sort_order: number;
};

type Expense = {
  id: string;
  amount_minor: number;
  category_id: string;
  free_text_category: string | null;
  note: string | null;
  spent_at: string;
};

type Props = {
  expenses: Expense[];
  categories: Category[];
  currentPeriodFrom: string;
  currentPeriodTo: string;
};

type FormState = {
  mode: 'create' | 'edit';
  expense?: Expense;
};

function ExpenseForm({
  categories,
  initialValues,
  onCancel,
  onSaved,
}: {
  categories: Category[];
  initialValues?: Expense;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('finance.expense');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [categoryId, setCategoryId] = useState(
    initialValues?.category_id ?? categories[0]?.id ?? '',
  );
  const [freeText, setFreeText] = useState(initialValues?.free_text_category ?? '');
  const [amount, setAmount] = useState(initialValues ? String(initialValues.amount_minor) : '');
  const [date, setDate] = useState(
    initialValues?.spent_at ?? new Date().toISOString().slice(0, 10),
  );
  const [note, setNote] = useState(initialValues?.note ?? '');

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const showFreeText = selectedCategory?.code === 'OTHER';

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      const amountMinor = Number.parseInt(amount, 10);
      if (!amountMinor || amountMinor <= 0) {
        setError('Montant invalide');
        return;
      }

      startTransition(async () => {
        const payload = {
          categoryId,
          freeTextCategory: showFreeText ? freeText || null : null,
          amountMinor,
          spentAt: date,
          note: note || null,
        };

        const result = initialValues
          ? await updateExpenseAction({ ...payload, id: initialValues.id })
          : await createExpenseAction(payload);

        if (result?.data?.ok) {
          onSaved();
        } else {
          setError(t('error'));
        }
      });
    },
    [categoryId, freeText, amount, date, note, showFreeText, initialValues, onSaved, t],
  );

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted" htmlFor="expense-category">
          {t('category')}
        </label>
        <select
          className="block h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
          id="expense-category"
          onChange={(e) => setCategoryId(e.target.value)}
          value={categoryId}
        >
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.label_fr}
            </option>
          ))}
        </select>
      </div>

      {showFreeText ? (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted" htmlFor="expense-freetext">
            {t('freeText')}
          </label>
          <input
            className="block h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
            id="expense-freetext"
            maxLength={100}
            onChange={(e) => setFreeText(e.target.value)}
            type="text"
            value={freeText}
          />
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted" htmlFor="expense-amount">
            {t('amount')}
          </label>
          <input
            className="block h-11 w-full rounded-md border border-border bg-surface px-3 font-mono text-sm text-text tabular-nums"
            id="expense-amount"
            min="1"
            onChange={(e) => setAmount(e.target.value)}
            required
            step="1"
            type="number"
            value={amount}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted" htmlFor="expense-date">
            {t('date')}
          </label>
          <input
            className="block h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
            id="expense-date"
            onChange={(e) => setDate(e.target.value)}
            required
            type="date"
            value={date}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted" htmlFor="expense-note">
          {t('note')}
        </label>
        <input
          className="block h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
          id="expense-note"
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          type="text"
          value={note}
        />
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="flex gap-3">
        <button
          className="min-h-11 flex-1 rounded-md bg-accent px-4 text-sm font-semibold text-text hover:bg-accent-hover disabled:opacity-60"
          disabled={isPending}
          type="submit"
        >
          {isPending ? '…' : t('save')}
        </button>
        <button
          className="min-h-11 rounded-md border border-border px-4 text-sm font-medium text-muted hover:bg-canvas hover:text-text"
          onClick={onCancel}
          type="button"
        >
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}

export function ExpenseSection({
  expenses,
  categories,
  currentPeriodFrom,
  currentPeriodTo,
}: Props) {
  const t = useTranslations('finance.expense');
  const [formState, setFormState] = useState<FormState | null>(null);
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<string | null>(null);
  const _ = currentPeriodFrom + currentPeriodTo; // suppress unused warning — used by parent for cache revalidation

  const totalMinor = expenses.reduce((sum, e) => sum + e.amount_minor, 0);

  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const handleDelete = useCallback(
    (id: string) => {
      if (!confirm(t('deleteConfirm'))) return;
      startTransition(async () => {
        const result = await deleteExpenseAction({ id });
        if (result?.data?.ok) {
          setFeedback(t('deleteSuccess'));
          setTimeout(() => setFeedback(null), 3000);
        }
      });
    },
    [t],
  );

  const handleSaved = useCallback(
    (isEdit: boolean) => {
      setFormState(null);
      setFeedback(isEdit ? t('updateSuccess') : t('success'));
      setTimeout(() => setFeedback(null), 3000);
    },
    [t],
  );

  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-1" id="depenses">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">{t('title')}</h2>
          {totalMinor > 0 && (
            <p className="mt-0.5 font-mono text-sm tabular-nums text-muted">
              {t('total')} : {formatMoney(totalMinor, 'XOF')}
            </p>
          )}
        </div>
        {formState === null && (
          <button
            className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-text hover:bg-accent-hover"
            onClick={() => setFormState({ mode: 'create' })}
            type="button"
          >
            {t('add')}
          </button>
        )}
      </div>

      {feedback ? <p className="mb-3 text-sm text-success">{feedback}</p> : null}

      {formState ? (
        <div className="mb-4 rounded-lg border border-border p-4">
          <ExpenseForm
            categories={categories}
            initialValues={formState.mode === 'edit' ? formState.expense : undefined}
            onCancel={() => setFormState(null)}
            onSaved={() => handleSaved(formState.mode === 'edit')}
          />
        </div>
      ) : null}

      {expenses.length === 0 && !formState ? (
        <p className="text-sm text-muted">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {expenses.map((expense) => {
            const cat = categoryById.get(expense.category_id);
            const label = expense.free_text_category
              ? `${cat?.label_fr ?? ''} – ${expense.free_text_category}`
              : (cat?.label_fr ?? expense.category_id);
            return (
              <li className="flex items-center justify-between gap-4 py-3" key={expense.id}>
                <div className="min-w-0">
                  <p className="truncate text-sm text-text">{label}</p>
                  <p className="text-xs text-muted">
                    {expense.spent_at}
                    {expense.note ? ` · ${expense.note}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="font-mono text-sm tabular-nums text-text">
                    {formatMoney(expense.amount_minor, 'XOF')}
                  </span>
                  <button
                    className="text-xs text-muted hover:text-text"
                    onClick={() => setFormState({ mode: 'edit', expense })}
                    type="button"
                  >
                    {t('edit')}
                  </button>
                  <button
                    className="text-xs text-danger hover:text-danger/80 disabled:opacity-60"
                    disabled={isPending}
                    onClick={() => handleDelete(expense.id)}
                    type="button"
                  >
                    {t('delete')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
