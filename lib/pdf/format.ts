import { formatMoney } from '@/lib/format/fcfa';

const NARROW_NO_BREAK_SPACE = /\u202F/g;

export function formatMoneyPdf(amount: number, currency: string | null | undefined = 'XOF') {
  return formatMoney(amount, currency).replace(NARROW_NO_BREAK_SPACE, '\u00A0');
}
