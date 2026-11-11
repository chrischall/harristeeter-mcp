import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { KrogerApi } from '../src/api/kroger.js';
import { resolveStore, saveChosenStore, rememberBrowserStore, readStoreFile, stateDir } from '../src/store.js';
import { registerProductTools } from '../src/tools/products.js';
import { HtClient } from '../src/client.js';
import { makeClient, stubTransport, PREFS } from './helpers/stub.js';

afterEach(() => {
  delete process.env.HARRISTEETER_LOCATION_ID;
});

/** A scripted api.kroger.com: three stores near any ZIP, and empty product searches. */
function fakeKroger() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.pathname === '/v1/connect/oauth2/token') return new Response(JSON.stringify({ access_token: 't', expires_in: 1800 }));
    if (url.pathname === '/v1/locations') {
      return new Response(
        JSON.stringify({
          data: [
            { locationId: '09700001', name: 'Harris Teeter - Alpha Road' },
            { locationId: '09700002', name: 'Harris Teeter - Beta Plaza' },
          ],
        }),
      );
    }
    return new Response(JSON.stringify({ data: [], meta: { pagination: { total: 0 } } }));
  }) as typeof fetch;
  return { api: new KrogerApi({ clientId: 'id', clientSecret: 's', fetchImpl }), calls };
}

const noBrowser = async () => undefined;
const browser = (locationId: string) => async () => ({ locationId, name: 'Live Store' });

describe('resolveStore order', () => {
  it('per-call beats saved beats env beats remembered beats live browser', async () => {
    const { api } = fakeKroger();
    // Only the live browser.
    expect(await resolveStore(api, {}, browser('09700005'))).toMatchObject({ locationId: '09700005', source: 'browser' });
    // Remembered beats live (no 30 s bridge wait when the browser is closed).
    await rememberBrowserStore({ locationId: '09700004' });
    expect(await resolveStore(api, {}, browser('09700005'))).toMatchObject({ locationId: '09700004', source: 'remembered-browser' });
    // The setting beats remembered.
    process.env.HARRISTEETER_LOCATION_ID = '09700003';
    expect(await resolveStore(api, {}, noBrowser)).toMatchObject({ locationId: '09700003', source: 'env' });
    // A saved choice beats the setting.
    await saveChosenStore({ locationId: '09700002', name: 'Beta' });
    expect(await resolveStore(api, {}, noBrowser)).toMatchObject({ locationId: '09700002', source: 'saved' });
    // A per-call store beats everything.
    expect(await resolveStore(api, { locationId: '09700001' }, noBrowser)).toMatchObject({ locationId: '09700001', source: 'call' });
  });

  it('says how to fix it when there is no store at all', async () => {
    const { api } = fakeKroger();
    await expect(resolveStore(api, {}, noBrowser)).rejects.toThrow(/No store to price against/);
  });

  it('a ZIP picks the nearest store, or the one whose name matches', async () => {
    const { api } = fakeKroger();
    expect(await resolveStore(api, { zip: '28209' }, noBrowser)).toMatchObject({ locationId: '09700001', source: 'call' });
    await saveChosenStore(null);
    const { lookupStore } = await import('../src/store.js');
    expect(await lookupStore(api, { zip: '28209', name: 'beta' })).toEqual({ locationId: '09700002', name: 'Harris Teeter - Beta Plaza' });
    await expect(lookupStore(api, { zip: '28209', name: 'gamma' })).rejects.toThrow(/matches "gamma"/);
  });
});

describe('state file', () => {
  it('is written 0600 inside the state dir and only when the remembered store changes', async () => {
    await rememberBrowserStore({ locationId: '09700004', name: 'X' });
    const file = join(stateDir(), 'store.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const first = readFileSync(file, 'utf8');
    await rememberBrowserStore({ locationId: '09700004', name: 'X' });
    expect(readFileSync(file, 'utf8')).toBe(first); // unchanged → no rewrite (same updatedAt)
    await rememberBrowserStore({ locationId: '09700009', name: 'Y' });
    expect(readStoreFile().rememberedFromBrowser?.locationId).toBe('09700009');
  });

  it('remembering never throws, even when the state dir cannot be written', async () => {
    process.env.HARRISTEETER_STATE_DIR = '/dev/null/not-a-dir';
    await expect(rememberBrowserStore({ locationId: '09700004' })).resolves.toBeUndefined();
  });
});

describe('the client remembers the browser store (A)', () => {
  it('calls onStore with the pickup store whenever it reads the store context', async () => {
    const seen: unknown[] = [];
    const { transport } = stubTransport(() => PREFS);
    const client = new HtClient({ transport, onStore: (s) => void seen.push(s) });
    await client.preferences();
    expect(seen).toEqual([{ locationId: '09700000', name: 'Test Store' }]);
  });
});

describe('store tools (B) and per-call store (C)', () => {
  it('ht_set_store saves a choice by ZIP + name, search then uses it and says so; clear forgets it', async () => {
    const { api, calls } = fakeKroger();
    const { client } = makeClient(() => {
      throw new Error('bridge must not be called');
    });
    const h = await createTestHarness((s) => registerProductTools(s, client, api));
    const set = parseToolResult<{ saved: { locationId: string } }>(await h.callTool('ht_set_store', { zip: '28209', name: 'beta' }));
    expect(set.saved.locationId).toBe('09700002');
    const out = parseToolResult<{ store: { locationId: string; source: string } }>(await h.callTool('ht_search_products', { query: 'milk' }));
    expect(out.store).toMatchObject({ locationId: '09700002', source: 'saved' });
    expect(new URL(calls.filter((c) => c.includes('/v1/products')).at(-1)!).searchParams.get('filter.locationId')).toBe('09700002');
    await h.callTool('ht_set_store', { clear: true });
    await h.close();
    expect(readStoreFile().chosen).toBeUndefined();
  });

  it('a per-call ZIP overrides the saved store for that call only', async () => {
    const { api, calls } = fakeKroger();
    await saveChosenStore({ locationId: '09700002' });
    const { client } = makeClient(() => {
      throw new Error('bridge must not be called');
    });
    const h = await createTestHarness((s) => registerProductTools(s, client, api));
    const out = parseToolResult<{ store: { locationId: string; source: string } }>(await h.callTool('ht_search_products', { query: 'milk', zip: '28209' }));
    await h.close();
    expect(out.store).toMatchObject({ locationId: '09700001', source: 'call' });
    expect(readStoreFile().chosen?.locationId).toBe('09700002');
    expect(calls.some((c) => c.includes('/v1/locations'))).toBe(true);
  });

  it('a per-call store without Kroger API credentials is refused, not silently ignored', async () => {
    const { client } = makeClient(() => PREFS);
    const h = await createTestHarness((s) => registerProductTools(s, client, new KrogerApi({ clientId: '', clientSecret: '' })));
    const res = await h.callTool('ht_search_products', { query: 'milk', zip: '28209' });
    await h.close();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/needs Kroger API credentials/);
  });

  it('ht_get_store reports the browser store, the search store and where it came from', async () => {
    const { api } = fakeKroger();
    await saveChosenStore({ locationId: '09700002', name: 'Beta' });
    const { client } = makeClient(() => PREFS);
    const h = await createTestHarness((s) => registerProductTools(s, client, api));
    const out = parseToolResult<{ browser: { pickupStore: { locationId: string } }; search: { source: string; locationId: string } }>(
      await h.callTool('ht_get_store', {}),
    );
    await h.close();
    expect(out.browser.pickupStore.locationId).toBe('09700000');
    expect(out.search).toMatchObject({ locationId: '09700002', source: 'saved' });
  });

  it('ht_get_store keeps the 0.2.0 top-level pickupStore / activeModality fields (follow-up #11)', async () => {
    const { api } = fakeKroger();
    const { client } = makeClient(() => PREFS);
    const h = await createTestHarness((s) => registerProductTools(s, client, api));
    const out = parseToolResult<{ pickupStore: { locationId: string }; activeModality: string }>(await h.callTool('ht_get_store', {}));
    await h.close();
    expect(out.pickupStore).toMatchObject({ locationId: '09700000', name: 'Test Store' });
    expect(out.activeModality).toBe('PICKUP');
  });

  it('ht_get_store still fails, as in 0.2.0, when it can say nothing at all', async () => {
    const { client } = makeClient(() => ({ status: 401, body: '{}' }));
    const h = await createTestHarness((s) => registerProductTools(s, client, new KrogerApi({ clientId: '', clientSecret: '' })));
    const res = await h.callTool('ht_get_store', {});
    await h.close();
    expect(res.isError).toBe(true);
  });
});
