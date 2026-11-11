// Shopping lists (atlas shopping-list service).
// Reads verified live. Writes follow the site's list-details bundle:
// POST create, PUT /{listId} {name, versionKey, lineItems} (quantity 0 removes),
// DELETE /{listId}. The line-item shape is pinned by the live test in
// docs/HT-API.md — see LIST_ITEM_SHAPE_VERIFIED.

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
  /** Free-text item, as the list page's "Add Items" box takes. */
  description: string;
  upc?: string;
  /** 0 removes. */
  quantity: number;
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
