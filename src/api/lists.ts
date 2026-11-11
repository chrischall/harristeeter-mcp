// Shopping lists (atlas shopping-list service).
// Reads verified live. Writes follow the site's list-details bundle:
// POST create, PUT /{listId} {name, versionKey, lineItems} (quantity 0 removes),
// DELETE /{listId}. Line items (verified live 2026-11-11 on a real list):
// {id, name, upc, type:"UPC", channel:"WEB", checked, quantity, categoryId, comments}.
// A free-text {description, quantity} item is accepted and silently dropped.

import { McpToolError } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';

type Rec = Record<string, unknown>;
const BASE = '/shopping-list/v1/shopping-lists';

export async function listLists(client: HtClient): Promise<Rec[]> {
  const json = await client.api<{ data?: { shoppingLists?: Rec[] } }>('GET', BASE, { laf: true });
  return json?.data?.shoppingLists ?? [];
}

function assertListId(id: string): string {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) throw new McpToolError(`Invalid list id "${id}" — use a listId from ht_list_shopping_lists.`);
  return id;
}

export async function getList(client: HtClient, listId: string): Promise<Rec | undefined> {
  const json = await client.api<{ data?: { shoppingLists?: Rec } }>('GET', `${BASE}/${assertListId(listId)}`, {
    laf: true,
    query: { projections: 'shoppingLists.full' },
  });
  return json?.data?.shoppingLists;
}

export async function createList(client: HtClient, name: string): Promise<Rec | undefined> {
  const json = await client.api<{ data?: { shoppingLists?: Rec } }>('POST', BASE, { laf: true, body: { name } });
  return json?.data?.shoppingLists;
}

export async function deleteList(client: HtClient, listId: string): Promise<void> {
  await client.api('DELETE', `${BASE}/${assertListId(listId)}`, { laf: true });
}

export interface ListItemChange {
  /** 13-digit UPC (from search). */
  upc: string;
  /** Absolute quantity; 0 removes the line. */
  quantity: number;
  /** Display name for a NEW line (existing lines keep theirs). */
  name?: string;
}

/**
 * Read-modify-write: send every current line, with the changes applied
 * (quantity 0 removes). Verified live that a lone quantity-0 line removes only
 * itself, and that the full list plus a new line adds it; sending the whole
 * list is safe whichever way the service treats omitted lines.
 */
export async function setListItems(client: HtClient, listId: string, changes: ListItemChange[]): Promise<Rec | undefined> {
  const current = await getList(client, listId);
  if (!current) throw new McpToolError(`Shopping list ${listId} not found.`);
  const lines = Array.isArray(current.lineItems) ? (current.lineItems as Rec[]).map((l) => ({ ...l })) : [];
  for (const c of changes) {
    const at = lines.findIndex((l) => l.upc === c.upc);
    if (at >= 0) lines[at] = { ...lines[at], quantity: c.quantity };
    else if (c.quantity > 0) {
      lines.push({ name: c.name ?? c.upc, upc: c.upc, type: 'UPC', channel: 'WEB', checked: false, quantity: c.quantity, comments: '' });
    } else throw new McpToolError(`UPC ${c.upc} is not on this list, so there is nothing to remove.`);
  }
  return updateList(client, listId, { items: lines });
}

/** PUT the list with changed lines. The list's current versionKey is read first. */
export async function updateList(
  client: HtClient,
  listId: string,
  change: { name?: string; items?: Rec[] },
): Promise<Rec | undefined> {
  const current = await getList(client, listId);
  if (!current) throw new McpToolError(`Shopping list ${listId} not found.`);
  const json = await client.api<{ data?: { shoppingLists?: Rec } }>('PUT', `${BASE}/${assertListId(listId)}`, {
    laf: true,
    body: { name: change.name ?? current.name, versionKey: current.versionKey, lineItems: change.items ?? [] },
  });
  return json?.data?.shoppingLists;
}
