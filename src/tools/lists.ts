import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, minifiedResult, McpToolError, confirmWrite, confirmTokenParam, CONFIRM_FLOW_SENTENCE } from '@chrischall/mcp-utils';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { HtClient } from '../client.js';
import { listLists, getList, createList, deleteList, updateList } from '../api/lists.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

type Rec = Record<string, unknown>;
const ListId = z.string().regex(/^[0-9a-fA-F-]{8,64}$/).describe('listId from ht_list_shopping_lists.');

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
}
