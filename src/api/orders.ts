// Upcoming orders and receipt detail (post-order APIs).

import { McpToolError } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';

type Rec = Record<string, unknown>;

/** Orders placed but not yet picked up. Needs `x-application-name` (any value; 400 without). */
export async function pendingOrders(client: HtClient): Promise<Rec[]> {
  const json = await client.api<{ data?: { pendingOrderSummaries?: { data?: Rec[] } } }>(
    'GET',
    '/post-order/v1/pending-order-summaries',
    { laf: true, headers: { 'x-application-name': 'WEB' } },
  );
  return json?.data?.pendingOrderSummaries?.data ?? [];
}

/**
 * The purchase list keys a receipt as `div~store~date~terminal~txn`; the
 * details endpoint wants `date_div_store_terminal_txn` (verified live).
 * An already-converted key passes through.
 */
export function toDetailKey(receiptKey: string): string {
  const k = receiptKey.trim();
  const parts = k.split('~');
  if (parts.length === 5) {
    const [div, store, date, term, txn] = parts;
    return `${date}_${div}_${store}_${term}_${txn}`;
  }
  if (/^\d{4}-\d{2}-\d{2}_\d+_\d+_\d+_\d+$/.test(k)) return k;
  throw new McpToolError(`Unrecognised receipt key "${receiptKey}" — pass a receiptKey from ht_list_orders.`);
}

export async function receiptDetail(client: HtClient, receiptKey: string): Promise<Rec | undefined> {
  const json = await client.api<{ data?: { purchaseHistoryDetails?: Rec[] } }>('POST', '/purchase-history/v2/details', {
    laf: true,
    headers: { 'x-isreceipt': 'true' },
    body: [toDetailKey(receiptKey)],
  });
  return json?.data?.purchaseHistoryDetails?.[0];
}
