// Recipes (atlas recipe service). `filter.query` searches; `filter.keyword` is ignored.

import type { HtClient } from '../client.js';

type Rec = Record<string, unknown>;

export async function searchRecipes(client: HtClient, opts: { query?: string; limit?: number; offset?: number }) {
  const json = await client.api<{ data?: { recipes?: { data?: { recipes?: Rec[] }; meta?: Rec } } }>(
    'GET',
    '/recipe/recipes',
    { query: { 'filter.query': opts.query, 'page.offset': opts.offset ?? 0, 'page.size': opts.limit ?? 10 } },
  );
  const r = json?.data?.recipes;
  return { recipes: r?.data?.recipes ?? [], total: r?.meta?.totalRecipesCount, hasMore: (r?.meta?.page as Rec | undefined)?.hasMore };
}

export async function getRecipe(client: HtClient, id: string): Promise<Rec | undefined> {
  // The full projection matches ingredients to store products, so it needs the
  // division (first 3 digits of the pickup locationId): 400 MISSING_DIVISION without.
  const division = (await client.preferences()).pickup?.locationId?.slice(0, 3);
  const json = await client.api<{ data?: { recipes?: { data?: { recipes?: Rec } } } }>(
    'GET',
    `/recipe/recipes/${encodeURIComponent(id)}`,
    { query: { projections: 'recipes.full', 'filter.division': division } },
  );
  return json?.data?.recipes?.data?.recipes;
}
