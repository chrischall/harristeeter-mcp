import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, McpToolError } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';
import { searchRecipes, getRecipe } from '../api/recipes.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

type Rec = Record<string, unknown>;

export function registerRecipeTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_search_recipes',
    {
      description: 'Search Harris Teeter recipes by keyword — title, total time, servings and ingredient count. Use ht_get_recipe for ingredients, steps and matching products.',
      annotations: toolAnnotations({ title: 'Search recipes', openWorld: true }),
      inputSchema: z.object({
        query: z.string().trim().min(1).max(100).describe('e.g. "chicken", "vegetarian chili".'),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).default(0),
        view: viewArg(),
      }),
      _meta: foodMeta('lookup', { aliases: ['recipes', 'dinner ideas', 'what to cook'] }),
    },
    async ({ query, limit, offset, view }) => {
      const r = await searchRecipes(client, { query, limit: limit ?? 10, offset: offset ?? 0 });
      return viewResponse(view, r, (d) => {
        const x = d as typeof r;
        return {
          total: x.total,
          hasMore: x.hasMore,
          recipes: x.recipes.map((c) => ({ id: c.id, title: c.title, minutes: c.totalTimeInMinutes, servings: c.servings, ingredients: c.ingredientCount })),
        };
      });
    },
  );

  server.registerTool(
    'ht_get_recipe',
    {
      description: 'Read a Harris Teeter recipe: ingredients, steps, times, servings, and the store products (UPCs) matched to each ingredient — ready for ht_add_to_cart.',
      annotations: toolAnnotations({ title: 'Get recipe', openWorld: true }),
      inputSchema: z.object({ id: z.string().regex(/^[A-Za-z0-9-]{4,64}$/).describe('Recipe id from ht_search_recipes.'), view: viewArg() }),
      _meta: foodMeta('lookup'),
    },
    async ({ id, view }) => {
      const r = await getRecipe(client, id);
      if (!r) throw new McpToolError(`Recipe ${id} not found.`);
      return viewResponse(view, r, (d) => {
        const x = d as Rec;
        const matched = ((x.ingredientProducts as Rec | undefined)?.ingredients as Rec[] | undefined) ?? [];
        return {
          id: x.id,
          title: x.title,
          description: x.description,
          servings: x.servings,
          prepMinutes: x.prepTimeInMinutes,
          cookMinutes: x.cookTimeInMinutes,
          ingredients: ((x.ingredients as Rec[] | undefined) ?? []).map((i) => i.summary),
          steps: ((x.instructions as Rec[] | undefined) ?? []).map((s) => s.task),
          products: matched.map((m) => ({
            ingredient: m.summary,
            upcs: ((m.products as Rec[] | undefined) ?? []).slice(0, 3).map((p) => p.upc),
          })),
        };
      });
    },
  );
}
