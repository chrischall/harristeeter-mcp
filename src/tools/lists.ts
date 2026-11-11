import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, minifiedResult, McpToolError, confirmWrite, confirmTokenParam, CONFIRM_FLOW_SENTENCE } from '@chrischall/mcp-utils';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { HtClient } from '../client.js';
import { listLists, getList, createList, deleteList, updateList, setListItems } from '../api/lists.js';
import { toGtin13 } from '../client.js';
import { compactProduct } from '../project.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

type Rec = Record<string, unknown>;
const ListId = z.string().regex(/^[0-9a-fA-F-]{8,64}$/).describe('listId from ht_list_shopping_lists.');

const Upc = z.string().regex(/^\d{1,14}$/).describe('UPC from ht_search_products.');

/** Re-read and report any requested line that did not land. */
async function applyListChanges(client: HtClient, listId: string, changes: { upc: string; quantity: number; name?: string }[]) {
  await setListItems(client, listId, changes);
  const after = await getList(client, listId);
  const lines = Array.isArray(after?.lineItems) ? (after!.lineItems as Rec[]) : [];
  const missed = changes.filter((c) => (Number(lines.find((l) => l.upc === c.upc)?.quantity ?? 0)) !== c.quantity);
  return minifiedResult({
    ...compactList(after ?? { listId }),
    ...(missed.length ? { warning: `Harris Teeter did not apply ${missed.length} change(s): ${missed.map((m) => m.upc).join(', ')}.` } : {}),
  });
}

function compactList(l: Rec) {
  return {
    listId: l.listId,
    name: l.name,
    itemCount: l.itemCount,
    modified: (l.modified as Rec | undefined)?.value,
    ...(Array.isArray(l.lineItems) ? { items: l.lineItems } : {}),
  };
}

export function registerListTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_list_shopping_lists',
    {
      description: 'List your Harris Teeter shopping lists — name, item count and listId.',
      annotations: toolAnnotations({ title: 'Shopping lists', openWorld: true }),
      inputSchema: z.object({}),
      _meta: foodMeta('lookup', { aliases: ['shopping list', 'grocery list'] }),
    },
    async () => minifiedResult((await listLists(client)).map(compactList)),
  );

  server.registerTool(
    'ht_get_shopping_list',
    {
      description: 'Read one Harris Teeter shopping list with its items.',
      annotations: toolAnnotations({ title: 'Get shopping list', openWorld: true }),
      inputSchema: z.object({ listId: ListId, view: viewArg() }),
      _meta: foodMeta('lookup'),
    },
    async ({ listId, view }) => {
      const l = await getList(client, listId);
      if (!l) throw new McpToolError(`Shopping list ${listId} not found.`);
      return viewResponse(view, l, (d) => compactList(d as Rec));
    },
  );

  server.registerTool(
    'ht_create_shopping_list',
    {
      description: 'Create a new, empty Harris Teeter shopping list. Remove it with ht_delete_shopping_list.',
      annotations: toolAnnotations({ title: 'Create shopping list', readOnly: false, destructive: false, openWorld: true }),
      inputSchema: z.object({ name: z.string().trim().min(1).max(60) }),
      _meta: foodMeta('change'),
    },
    async ({ name }) => minifiedResult(compactList((await createList(client, name)) ?? { name })),
  );

  server.registerTool(
    'ht_rename_shopping_list',
    {
      description: 'Rename a Harris Teeter shopping list.',
      annotations: toolAnnotations({ title: 'Rename shopping list', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({ listId: ListId, name: z.string().trim().min(1).max(60) }),
      _meta: foodMeta('change'),
    },
    async ({ listId, name }) => {
      const current = await getList(client, listId);
      if (!current) throw new McpToolError(`Shopping list ${listId} not found.`);
      const items = Array.isArray(current.lineItems) ? (current.lineItems as Rec[]) : [];
      return minifiedResult(compactList((await updateList(client, listId, { name, items })) ?? { listId, name }));
    },
  );

  server.registerTool(
    'ht_delete_shopping_list',
    {
      description: `Delete a Harris Teeter shopping list and everything on it. Cannot be undone. ${CONFIRM_FLOW_SENTENCE}`,
      annotations: toolAnnotations({ title: 'Delete shopping list', readOnly: false, destructive: true, openWorld: true }),
      inputSchema: z.object({ listId: ListId, confirmToken: confirmTokenParam }),
      _meta: foodMeta('change'),
    },
    async ({ listId, confirmToken }, ctx: ServerContext) => {
      const l = await getList(client, listId);
      if (!l) throw new McpToolError(`Shopping list ${listId} not found.`);
      const gate = await confirmWrite(ctx, {
        tool: 'ht_delete_shopping_list',
        action: 'Delete a Harris Teeter shopping list',
        summary: `Delete "${String(l.name)}" (${String(l.itemCount ?? 0)} items)`,
        account: undefined,
        target: listId,
        revision: typeof l.versionKey === 'string' ? l.versionKey : null,
        request: { method: 'DELETE', path: `/atlas/v1/shopping-list/v1/shopping-lists/${listId}` },
        preview: { name: l.name, itemCount: l.itemCount },
        args: { listId },
        confirmToken,
      });
      if (gate) return gate;
      await deleteList(client, listId);
      const still = (await listLists(client)).some((x) => x.listId === listId);
      return minifiedResult({ deleted: !still, listId, name: l.name });
    },
  );

  server.registerTool(
    'ht_add_to_shopping_list',
    {
      description: 'Add items to a Harris Teeter shopping list by UPC (adds to any quantity already there). Undo with ht_remove_from_shopping_list.',
      annotations: toolAnnotations({ title: 'Add to shopping list', readOnly: false, destructive: false, openWorld: true }),
      inputSchema: z.object({
        listId: ListId,
        items: z.array(z.object({ upc: Upc, quantity: z.number().int().min(1).max(99).default(1) })).min(1).max(50),
      }),
      _meta: foodMeta('change', { aliases: ['add to list', 'add to grocery list'] }),
    },
    async ({ listId, items }) => {
      const current = await getList(client, listId);
      if (!current) throw new McpToolError(`Shopping list ${listId} not found.`);
      const have = new Map((Array.isArray(current.lineItems) ? (current.lineItems as Rec[]) : []).map((l) => [String(l.upc), Number(l.quantity ?? 0)]));
      const upcs = items.map((i) => toGtin13(i.upc));
      const names = new Map(
        (await client.getProducts(upcs.filter((u) => !have.has(u)))).map((p) => [String((p.item as Rec | undefined)?.upc ?? ''), compactProduct(p)?.description]),
      );
      const merged = new Map<string, { upc: string; quantity: number; name?: string }>();
      items.forEach((i, n) => {
        const upc = upcs[n]!;
        const prev = merged.get(upc)?.quantity ?? have.get(upc) ?? 0;
        const name = names.get(upc);
        merged.set(upc, { upc, quantity: prev + (i.quantity ?? 1), ...(name ? { name } : {}) });
      });
      return applyListChanges(client, listId, [...merged.values()]);
    },
  );

  server.registerTool(
    'ht_remove_from_shopping_list',
    {
      description: 'Remove items from a Harris Teeter shopping list by UPC. Re-add with ht_add_to_shopping_list.',
      annotations: toolAnnotations({ title: 'Remove from shopping list', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({ listId: ListId, upcs: z.array(Upc).min(1).max(50) }),
      _meta: foodMeta('change'),
    },
    async ({ listId, upcs }) => applyListChanges(client, listId, upcs.map((u) => ({ upc: toGtin13(u), quantity: 0 }))),
  );
}
