// Kroger's official developer API (api.kroger.com) — the bridge-free path for
// product search, prices and store lookup.
//
// harristeeter.com itself resets every server-side connection (Akamai), but
// api.kroger.com answers a plain Node request. With an app's client
// credentials (KROGER_API_CLIENT_ID / KROGER_API_CLIENT_SECRET, registered at
// developer.kroger.com) it serves Harris Teeter stores (chain "HART") with
// their shelf prices and stock — verified live 2026-11-11.
//
// What it does NOT give: anything that needs the customer. Kroger's consent
// sign-in (cart.basic:write) rejected a Harris Teeter account's credentials
// even with the Harris Teeter banner hint, so cart, checkout, coupons, lists,
// Order Ahead and pharmacy stay on the bridge.

import { McpToolError, readEnvVar, createApiClient } from '@chrischall/mcp-utils';

type Rec = Record<string, unknown>;

export const KROGER_API_BASE = 'https://api.kroger.com';
/** Harris Teeter's chain code on the Kroger API (live: "HARRISTEETER" returns nothing). */
export const HT_CHAIN = 'HART';

export interface KrogerApiOptions {
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class KrogerApi {
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token?: { value: string; expiresAt: number };
  private api?: ReturnType<typeof createApiClient>;
  private tokenInFlight?: Promise<string>;

  constructor(opts: KrogerApiOptions = {}) {
    this.clientId = opts.clientId ?? readEnvVar('KROGER_API_CLIENT_ID');
    this.clientSecret = opts.clientSecret ?? readEnvVar('KROGER_API_CLIENT_SECRET', { trim: false });
    // Receiver-safe wrapper: a bare global fetch stored on an object throws
    // "Illegal invocation" on older undici.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  /** True when both credentials are set — the search tools then skip the bridge. */
  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  private async accessToken(): Promise<string> {
    if (!this.configured) {
      throw new McpToolError('Kroger API credentials are not configured.', {
        hint: 'Set KROGER_API_CLIENT_ID and KROGER_API_CLIENT_SECRET (an app from developer.kroger.com), or use the browser bridge.',
        kind: 'no_credential',
      });
    }
    if (this.token && this.now() < this.token.expiresAt - 60_000) return this.token.value;
    if (!this.tokenInFlight) {
      this.tokenInFlight = (async () => {
        const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        const res = await this.fetchImpl(`${KROGER_API_BASE}/v1/connect/oauth2/token`, {
          method: 'POST',
          headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials&scope=product.compact',
        });
        const text = await res.text();
        let j: Rec = {};
        try {
          j = JSON.parse(text) as Rec;
        } catch {
          /* handled below */
        }
        if (!res.ok || typeof j.access_token !== 'string') {
          throw new McpToolError(`Kroger API rejected the app credentials (${res.status}${typeof j.error === 'string' ? ` ${j.error}` : ''}).`, {
            hint: 'Check KROGER_API_CLIENT_ID / KROGER_API_CLIENT_SECRET against the app on developer.kroger.com.',
            status: res.status,
            kind: 'credential_rejected',
          });
        }
        const ttl = typeof j.expires_in === 'number' ? j.expires_in * 1000 : 30 * 60_000;
        this.token = { value: j.access_token, expiresAt: this.now() + ttl };
        return j.access_token;
      })().finally(() => {
        this.tokenInFlight = undefined;
      });
    }
    return this.tokenInFlight;
  }

  private client() {
    return (this.api ??= createApiClient({
      baseUrl: KROGER_API_BASE,
      getToken: () => this.accessToken(),
      fetchImpl: this.fetchImpl,
      onUnauthorized: () => {
        this.token = undefined;
        return new McpToolError('Kroger API token was rejected.', { kind: 'credential_rejected', status: 401 });
      },
    }));
  }

  async searchProducts(term: string, opts: { locationId: string; limit?: number; offset?: number; pickupOnly?: boolean }) {
    const j = (await this.client().fetchJson('GET', '/v1/products', {
      query: {
        'filter.term': term,
        'filter.locationId': opts.locationId,
        'filter.limit': Math.min(opts.limit ?? 10, 50),
        // Server-side: "csp" = curbside pickup at that store.
        ...(opts.pickupOnly ? { 'filter.fulfillment': 'csp' } : {}),
        ...(opts.offset ? { 'filter.start': opts.offset } : {}),
      },
    })) as { data?: Rec[]; meta?: { pagination?: { total?: number } } };
    return { total: j?.meta?.pagination?.total, products: j?.data ?? [] };
  }

  async getProduct(upc: string, locationId: string): Promise<Rec | undefined> {
    const j = (await this.client().fetchJson('GET', `/v1/products/${encodeURIComponent(upc)}`, {
      query: { 'filter.locationId': locationId },
    })) as { data?: Rec };
    return j?.data;
  }

  async findStores(zip: string, limit = 5): Promise<Rec[]> {
    const j = (await this.client().fetchJson('GET', '/v1/locations', {
      query: { 'filter.zipCode.near': zip, 'filter.chain': HT_CHAIN, 'filter.limit': limit },
    })) as { data?: Rec[] };
    return j?.data ?? [];
  }
}

/** Kroger API product → the same compact shape the bridge path returns. */
export function compactApiProduct(p: Rec) {
  const item = ((p.items as Rec[] | undefined) ?? [])[0] ?? {};
  const price = (item.price ?? {}) as Rec;
  const fulfillment = (item.fulfillment ?? {}) as Rec;
  const out = {
    upc: p.upc,
    description: p.description,
    brand: p.brand,
    size: item.size,
    price: price.regular,
    salePrice: typeof price.promo === 'number' && price.promo > 0 ? price.promo : undefined,
    stock: (item.inventory as Rec | undefined)?.stockLevel,
    pickup: fulfillment.curbside,
    aisle: ((p.aisleLocations as Rec[] | undefined) ?? [])[0]?.description,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/** The store the API path searches: HARRISTEETER_LOCATION_ID, else none (caller falls back to the bridge's store). */
export function configuredLocationId(): string | undefined {
  const v = readEnvVar('HARRISTEETER_LOCATION_ID');
  if (v === undefined) return undefined;
  if (!/^\d{8}$/.test(v)) {
    throw new McpToolError(`HARRISTEETER_LOCATION_ID "${v}" is not an 8-digit store location id.`, {
      hint: 'Use ht_find_stores to look one up (8 digits, e.g. 09700123).',
      kind: 'no_credential',
    });
  }
  return v;
}
