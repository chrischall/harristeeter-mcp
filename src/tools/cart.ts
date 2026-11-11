import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, minifiedResult, McpToolError } from '@chrischall/mcp-utils';
import { cartLines, toGtin13, SUBSTITUTION_POLICIES, type HtClient, type CartChange } from '../client.js';
import { compactProduct } from '../project.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

const Upc = z.string().regex(/^\d{1,14}$/, 'digits only').describe('Product UPC from ht_search_products.');
const Substitution = z
  .enum(SUBSTITUTION_POLICIES)
  .optional()
  .describe('If the item is out of stock: SHOPPER_CHOICE (default — the shopper picks a similar item), CUSTOMER_CHOICE, CONTACT_CUSTOMER, or NONE (no substitute).');

/** The cart with each line's product name/price filled in. */
async function hydratedCart(client: HtClient) {
  const cart = await client.getCart();
  const lines = cartLines(cart);
  const products = await client.getProducts(lines.map((l) => l.upc));
  const byUpc = new Map(products.map((p) => [String((p.item as Record<string, unknown>)?.upc ?? ''), p]));
  return { cart, lines, byUpc };
}

function cartSummary(lines: ReturnType<typeof cartLines>, byUpc: Map<string, Record<string, unknown>>) {
  let estimate = 0;
  const items = lines.map((l) => {
    const p = byUpc.get(l.upc);
    const c = p ? compactProduct(p) : undefined;
    const each = c?.salePrice ?? c?.price;
    if (each !== undefined) estimate += each * l.quantity;
    return {
      upc: l.upc,
      quantity: l.quantity,
      description: c?.description,
      size: c?.size,
      price: c?.price,
      salePrice: c?.salePrice,
      substitutionPolicy: l.substitutionPolicy,
    };
  });
  return {
    lineCount: items.length,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    estimatedSubtotal: Math.round(estimate * 100) / 100,
    note: 'estimatedSubtotal is shelf price x quantity, before coupons, fees and tax; ht_start_checkout returns the real totals.',
    items,
  };
}

async function applyAndSummarise(client: HtClient, changes: CartChange[]) {
  await client.setCartItems(changes);
  const { lines, byUpc } = await hydratedCart(client);
  // Verify by re-reading: a 200 from the cart PUT is not proof the line moved.
  const mismatched = changes.filter((c) => {
    const now = lines.find((l) => l.upc === toGtin13(c.upc))?.quantity ?? 0;
    return now !== c.quantity;
  });
  return minifiedResult({
    ...cartSummary(lines, byUpc),
    ...(mismatched.length
      ? {
          warning: `Harris Teeter did not apply ${mismatched.length} change(s): ${mismatched
            .map((m) => toGtin13(m.upc))
            .join(', ')}. The item may be unavailable at your store or over its purchase limit.`,
        }
      : {}),
  });
}

export function registerCartTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_get_cart',
    {
      description: 'Show the Harris Teeter cart — each item with quantity, name, size and price, plus an estimated subtotal.',
      annotations: toolAnnotations({ title: 'Get cart', openWorld: true }),
      inputSchema: z.object({ view: viewArg() }),
      _meta: foodMeta('lookup', { aliases: ['grocery cart', 'shopping cart', 'harris teeter cart'] }),
    },
    async ({ view }) => {
      const { cart, lines, byUpc } = await hydratedCart(client);
      return viewResponse(view, cart ?? {}, () => cartSummary(lines, byUpc));
    },
  );

  server.registerTool(
    'ht_add_to_cart',
    {
      description:
        'Add groceries to the Harris Teeter cart by UPC. Adds to any quantity already in the cart. Reversible with ht_update_cart_item / ht_remove_from_cart; nothing is ordered or charged.',
      annotations: toolAnnotations({ title: 'Add to cart', readOnly: false, destructive: false, openWorld: true }),
      inputSchema: z.object({
        items: z
          .array(z.object({ upc: Upc, quantity: z.number().int().min(1).max(99).default(1), substitutionPolicy: Substitution }))
          .min(1)
          .max(50),
      }),
      _meta: foodMeta('change', { aliases: ['add to grocery list', 'buy groceries'] }),
    },
    async ({ items }) => {
      const current = new Map(cartLines(await client.getCart()).map((l) => [l.upc, l.quantity]));
      const merged = new Map<string, CartChange>();
      for (const i of items) {
        const upc = toGtin13(i.upc);
        const prev = merged.get(upc)?.quantity ?? current.get(upc) ?? 0;
        merged.set(upc, { upc, quantity: prev + (i.quantity ?? 1), ...(i.substitutionPolicy ? { substitutionPolicy: i.substitutionPolicy } : {}) });
      }
      return applyAndSummarise(client, [...merged.values()]);
    },
  );

  server.registerTool(
    'ht_update_cart_item',
    {
      description:
        'Set the quantity (or substitution preference) of items already in the Harris Teeter cart. Quantity 0 removes the item. Nothing is ordered or charged.',
      annotations: toolAnnotations({ title: 'Update cart item', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        items: z
          .array(z.object({ upc: Upc, quantity: z.number().int().min(0).max(99), substitutionPolicy: Substitution }))
          .min(1)
          .max(50),
      }),
      _meta: foodMeta('change'),
    },
    async ({ items }) => {
      const inCart = new Set(cartLines(await client.getCart()).map((l) => l.upc));
      const missing = items.filter((i) => !inCart.has(toGtin13(i.upc)));
      if (missing.length) {
        throw new McpToolError(`Not in the cart: ${missing.map((m) => toGtin13(m.upc)).join(', ')}.`, {
          hint: 'Use ht_add_to_cart for new items.',
        });
      }
      return applyAndSummarise(
        client,
        items.map((i) => ({ upc: i.upc, quantity: i.quantity, ...(i.substitutionPolicy ? { substitutionPolicy: i.substitutionPolicy } : {}) })),
      );
    },
  );

  server.registerTool(
    'ht_remove_from_cart',
    {
      description: 'Remove items from the Harris Teeter cart by UPC. Re-add with ht_add_to_cart.',
      annotations: toolAnnotations({ title: 'Remove from cart', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({ upcs: z.array(Upc).min(1).max(50) }),
      _meta: foodMeta('change'),
    },
    async ({ upcs }) => applyAndSummarise(client, upcs.map((upc) => ({ upc, quantity: 0 }))),
  );
}
