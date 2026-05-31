import {
  type NextActionViewItem,
  NextActionsListMotion,
} from '@/components/kpi/next-actions-list-motion';
import { formatDateRelative } from '@/lib/format/date';
import { formatFCFA } from '@/lib/format/fcfa';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

type SupabaseServerClient = SupabaseClient<Database>;

type NextActionsListProps = {
  emptyLabel: string;
  emptyValueLabel: string;
};

type NextActionOrder = {
  id: string;
  order_number: string | null;
  total_amount: number;
  created_at: string;
  customer: {
    full_name: string | null;
    phone: string | null;
  } | null;
};

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function formatOrderNumber(value: string | null, emptyValueLabel: string): string {
  if (!value) {
    return emptyValueLabel;
  }

  return value.startsWith('#') ? value : `#${value}`;
}

async function getNextActionOrders(): Promise<NextActionOrder[]> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_number, total_amount, created_at, customer:customer_id(full_name, phone)')
    .eq('cod_status', 'A_APPELER')
    .order('created_at', { ascending: true })
    .limit(5);

  if (error) {
    throw error;
  }

  return (data ?? []) as NextActionOrder[];
}

export async function NextActionsList({ emptyLabel, emptyValueLabel }: NextActionsListProps) {
  const orders = await getNextActionOrders();
  const items: NextActionViewItem[] = orders.map((order) => ({
    id: order.id,
    href: `/commandes/${order.id}`,
    orderNumber: formatOrderNumber(order.order_number, emptyValueLabel),
    customerName: order.customer?.full_name ?? emptyValueLabel,
    phone: order.customer?.phone ?? emptyValueLabel,
    age: formatDateRelative(order.created_at),
    total: formatFCFA(order.total_amount),
  }));

  return <NextActionsListMotion emptyLabel={emptyLabel} items={items} />;
}
