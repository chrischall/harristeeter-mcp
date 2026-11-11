// Harris Teeter client.
//
// harristeeter.com is Kroger's web platform ("atlas" API under /atlas/v1/…)
// behind Akamai Bot Manager. Every call rides the user's signed-in browser tab
// through the fetchproxy bridge — there is no server-side path (see
// transport-fetchproxy.ts) — and the session is the tab's own cookies, so this
// client holds no credential of its own.
//
// Two headers carry the store context the atlas API needs, both verified live:
//   - `x-kroger-channel: WEB` on every call (else 400 MISSING_CHANNEL).
//   - `x-laf-object` (Location-Aware Fulfillment) on search, timeslot, cart and
//     checkout calls (else 400 LAF_OBJECTS_REQUIRED). The site builds it as
//     JSON.stringify(preferences.lafObject) from POST /atlas/v1/modality/preferences;
//     this client does the same, caches it, and re-reads it once if the API
//     rejects it.
//   - `user-time-zone` (an IANA zone) on timeslot calls (else 400
//     MISSING_TIMEZONE_HEADER).
//
// Placing the order is deliberately NOT here. The site submits it to a separate
// payment host (pay.harristeeter.com) from a hosted payment frame that attaches
// its own token plus fraud-screening and bot-manager telemetry; reproducing
// that from a server would mean faking those signals. The MCP stops at a draft
// checkout and the user presses "Place Order" in the browser. See docs/HT-API.md.

import { randomUUID } from 'node:crypto';
import { McpToolError } from '@chrischall/mcp-utils';
import type { HtTransport, BridgeMethod } from './transport.js';

export const ORIGIN = 'https://www.harristeeter.com';

/** Atlas API errors arrive as `{ errors: { code, reason, statusCode } }`. */
export class HtApiError extends McpToolError {
  readonly code?: string;
  constructor(status: number, code: string | undefined, reason: string | undefined, path: string) {
    super(
      `Harris Teeter API ${status}${code ? ` ${code}` : ''} on ${path.split('?')[0]}${reason ? `: ${reason}` : ''}`,
      { status, kind: 'http' },
    );
    this.name = 'HtApiError';
    if (code !== undefined) this.code = code;
  }
}

/** Raised when the tab's session is gone. Exported so tools never match prose. */
export class HtSignedOutError extends McpToolError {
  constructor(detail: string) {
    super(`Not signed in to harristeeter.com (${detail}).`, {
      hint: 'Open https://www.harristeeter.com in the browser running the ContextMint Bridge, sign in, keep the tab open, then retry.',
      kind: 'session_expired',
      status: 401,
    });
    this.name = 'HtSignedOutError';
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | (string | number)[] | undefined>;
  body?: unknown;
  /** Send `x-laf-object` (store context). */
  laf?: boolean;
  /** Send `user-time-zone`. */
  timeZone?: boolean;
  /** Send a fresh `x-idempotency-key` (the site does on writes). */
  idempotent?: boolean;
  /** Extra headers some atlas endpoints insist on (verified per endpoint). */
  headers?: Record<string, string>;
}

export interface StorePreferences {
  /** The `x-laf-object` header value. */
  laf: string;
  /** Pickup store, when the account has one. `locationId` is division (3 digits) + store (5 digits). */
  pickup?: { locationId: string; facilityId?: string; name?: string };
  activeModality?: string;
}

export interface CartLine {
  id?: string;
  upc: string;
  quantity: number;
  substitutionPolicy?: string;
}

export interface CartChange {
  upc: string;
  /** Absolute quantity to set; 0 removes the line. */
  quantity: number;
  substitutionPolicy?: SubstitutionPolicy;
}

export const SUBSTITUTION_POLICIES = ['SHOPPER_CHOICE', 'CUSTOMER_CHOICE', 'CONTACT_CUSTOMER', 'NONE'] as const;
export type SubstitutionPolicy = (typeof SUBSTITUTION_POLICIES)[number];

export interface Timeslot {
  optionId: string;
  quoteId: string;
  vendorId: string;
  vendorName?: string;
  /** e.g. "USD 4.95" */
  cost?: string;
  window: { value: string; timezone?: string };
  displayString?: string;
  storeId?: string;
  type?: string;
}

export interface TimeslotDay {
  dayLabel?: string;
  date?: { year?: number; month?: number; date?: number };
  times: Timeslot[];
}

export interface TimeslotQuote {
  days: TimeslotDay[];
  /** quoteId → the items the promise will include/exclude. */
  items: Record<string, { included?: unknown[]; excluded?: unknown[] }>;
}

const UPC_RE = /^\d{1,14}$/;

/** Normalise a UPC to the 13-digit gtin13 the API keys items by. */
export function toGtin13(upc: string): string {
  const v = upc.trim();
  if (!UPC_RE.test(v)) {
    throw new McpToolError(`Invalid UPC "${upc}" — expected digits only, as returned by ht_search_products.`);
  }
  if (v.length > 13) {
    if (v.length === 14 && v.startsWith('0')) return v.slice(1);
    throw new McpToolError(`Invalid UPC "${upc}" — longer than a GTIN-13.`);
  }
  return v.padStart(13, '0');
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) p.append(k, String(x));
    else p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function resolveTimeZone(explicit?: string): string {
  const fromEnv = process.env.MCP_USER_TZ?.trim();
  return explicit ?? (fromEnv || undefined) ?? 'America/New_York';
}

export interface HtClientOptions {
  transport: HtTransport;
  /** IANA zone sent as `user-time-zone`. Default: MCP_USER_TZ, else America/New_York (Harris Teeter's footprint). */
  timeZone?: string;
  /** How long the store context is trusted before re-reading it. Default 10 min. */
  prefsTtlMs?: number;
  /** Called with the pickup store each time the store context is read (remembered for bridge-free search). */
  onStore?: (store: { locationId: string; name?: string }) => void | Promise<void>;
  now?: () => number;
}

export class HtClient {
  private readonly transport: HtTransport;
  private readonly timeZone: string;
  private readonly prefsTtlMs: number;
  private readonly now: () => number;
  private readonly onStore?: HtClientOptions['onStore'];
  private prefs?: { value: StorePreferences; at: number };
  private prefsInFlight?: Promise<StorePreferences>;

  constructor(opts: HtClientOptions) {
    this.transport = opts.transport;
    this.timeZone = resolveTimeZone(opts.timeZone);
    this.prefsTtlMs = opts.prefsTtlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    this.onStore = opts.onStore;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  /** Raw text GET, for the healthcheck probe. */
  async fetchText(path: string): Promise<string> {
    const res = await this.transport.fetch({ method: 'GET', path, headers: { 'x-kroger-channel': 'WEB' } });
    if (res.status >= 400) throw new HtApiError(res.status, undefined, undefined, path);
    return res.body;
  }

  /**
   * One atlas call. Adds the store-context headers, maps errors, and re-reads
   * the store context once when the API rejects it.
   */
  async api<T = unknown>(method: BridgeMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    try {
      return await this.send<T>(method, path, opts);
    } catch (err) {
      if (opts.laf && err instanceof HtApiError && err.code === 'LAF_OBJECTS_REQUIRED') {
        this.prefs = undefined;
        return this.send<T>(method, path, opts);
      }
      throw err;
    }
  }

  private async send<T>(method: BridgeMethod, path: string, opts: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      'x-kroger-channel': 'WEB',
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.laf) headers['x-laf-object'] = (await this.preferences()).laf;
    if (opts.timeZone) headers['user-time-zone'] = this.timeZone;
    if (opts.idempotent) headers['x-idempotency-key'] = randomUUID();
    Object.assign(headers, opts.headers);
    const full = `/atlas/v1${path}${buildQuery(opts.query)}`;
    const res = await this.transport.fetch({
      method,
      path: full,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return parseAtlas<T>(res.status, res.body, full, res.url);
  }

  /**
   * A call outside /atlas/v1 — the Order Ahead (`/fresh/api`) and pharmacy
   * (`/rx/api`, `/rx-security`) apps. They take their own headers and answer
   * with their own error envelopes, so the caller maps the body.
   */
  async raw(
    method: BridgeMethod,
    path: string,
    opts: { query?: RequestOptions['query']; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; json: unknown; text: string }> {
    const headers: Record<string, string> = { accept: 'application/json, text/plain, */*', ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const full = `${path}${buildQuery(opts.query)}`;
    const res = await this.transport.fetch({
      method,
      path: full,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (res.url && /login\.kroger\.com|\/signin/i.test(res.url)) throw new HtSignedOutError('redirected to sign-in');
    const text = res.body;
    let json: unknown;
    const t = text.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        json = JSON.parse(t);
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, json, text };
  }

  /** Store context (LAF header + pickup store), cached and single-flight. */
  async preferences(): Promise<StorePreferences> {
    if (this.prefs && this.now() - this.prefs.at < this.prefsTtlMs) return this.prefs.value;
    if (!this.prefsInFlight) {
      this.prefsInFlight = (async () => {
        const json = await this.send<{ data?: { modalityPreferences?: Record<string, unknown> } }>(
          'POST',
          '/modality/preferences',
          { query: { 'filter.restrictLafToFc': 'true' }, body: {} },
        );
        const value = extractPreferences(json?.data?.modalityPreferences);
        this.prefs = { value, at: this.now() };
        if (value.pickup && this.onStore) {
          await Promise.resolve(this.onStore({ locationId: value.pickup.locationId, ...(value.pickup.name ? { name: value.pickup.name } : {}) })).catch(() => {});
        }
        return value;
      })().finally(() => {
        this.prefsInFlight = undefined;
      });
    }
    return this.prefsInFlight;
  }

  // ---- products ---------------------------------------------------------

  async searchProducts(query: string, opts: { limit?: number; offset?: number; pickupOnly?: boolean } = {}) {
    const prefs = await this.preferences();
    const json = await this.api<{
      data?: { productsSearch?: Record<string, unknown>[] };
      meta?: { productsSearch?: { totalCount?: number } };
    }>('GET', '/search/v1/products-search', {
      laf: true,
      query: {
        'filter.query': query,
        'filter.locationId': prefs.pickup?.locationId,
        'filter.fulfillmentMethods': opts.pickupOnly === false ? undefined : 'PICKUP',
        'page.size': opts.limit ?? 10,
        'page.offset': opts.offset ?? 0,
        'option.monetization': 'NONE',
      },
    });
    return {
      total: json?.meta?.productsSearch?.totalCount,
      hits: json?.data?.productsSearch ?? [],
    };
  }

  /** Full product records (price, size, stock at the pickup store). */
  async getProducts(upcs: string[]): Promise<Record<string, unknown>[]> {
    if (upcs.length === 0) return [];
    const json = await this.api<{ data?: { products?: Record<string, unknown>[] } }>(
      'GET',
      '/product/v2/products',
      {
        laf: true,
        query: { 'filter.gtin13s': upcs.map(toGtin13), 'filter.verified': 'true', projections: 'items.full' },
      },
    );
    return json?.data?.products ?? [];
  }

  // ---- cart -------------------------------------------------------------

  async getCart(): Promise<Record<string, unknown> | undefined> {
    const json = await this.api<{ data?: { carts?: Record<string, unknown>[] } }>('GET', '/carts');
    return json?.data?.carts?.[0];
  }

  /**
   * Set absolute quantities for the given UPCs (0 removes). The cart PUT
   * merges: only the named lines change, verified live 2026-11-11.
   */
  async setCartItems(changes: CartChange[]): Promise<Record<string, unknown> | undefined> {
    const cart = await this.getCart();
    const cartId = typeof cart?.id === 'string' ? cart.id : undefined;
    if (!cartId) {
      throw new McpToolError('No Harris Teeter cart found for this account.', {
        hint: 'Open https://www.harristeeter.com/cart once in the signed-in tab, then retry.',
      });
    }
    const prefs = await this.preferences();
    const modalityType = prefs.activeModality ?? 'PICKUP';
    const existing = new Map(cartLines(cart).map((l) => [l.upc, l]));
    const lineItems = changes.map((c) => {
      const gtin13 = toGtin13(c.upc);
      const prior = existing.get(gtin13);
      if (c.quantity === 0) {
        if (!prior) throw new McpToolError(`UPC ${gtin13} is not in the cart, so there is nothing to remove.`);
        return { id: prior.id, gtin13, quantity: 0, modalityType };
      }
      return {
        ...(prior?.id ? { id: prior.id } : {}),
        gtin13,
        channel: 'WEB',
        modalityType,
        quantity: c.quantity,
        substitutionPolicy: c.substitutionPolicy ?? prior?.substitutionPolicy ?? 'SHOPPER_CHOICE',
      };
    });
    const json = await this.api<{ data?: { carts?: Record<string, unknown> } }>(
      'PUT',
      `/carts/${encodeURIComponent(cartId)}`,
      { laf: true, body: { lineItems } },
    );
    return json?.data?.carts ?? (await this.getCart());
  }

  // ---- fulfillment + checkout ------------------------------------------

  /** Pickup windows for exactly what is in the cart now. */
  async listTimeslots(): Promise<TimeslotQuote> {
    const items = cartLines(await this.getCart()).map((l) => ({ gtin13: l.upc, quantity: l.quantity }));
    if (items.length === 0) throw new McpToolError('The cart is empty — add items before choosing a pickup time.');
    const json = await this.api<{ data?: { timeslots?: { days?: TimeslotDay[]; items?: TimeslotQuote['items'] } } }>(
      'POST',
      '/promising/v4/timeslots',
      { laf: true, timeZone: true, idempotent: true, body: { items } },
    );
    return { days: json?.data?.timeslots?.days ?? [], items: json?.data?.timeslots?.items ?? {} };
  }

  /** Reserve a window (a "promise"). Expires on its own if no order follows. */
  async reserveTimeslot(slot: Timeslot, quoteItems: unknown[]): Promise<Record<string, unknown>> {
    const json = await this.api<{ data?: { promises?: Record<string, unknown> } }>('POST', '/promising/v4/promises/', {
      laf: true,
      timeZone: true,
      body: {
        optionIds: [slot.optionId],
        vendorId: slot.vendorId,
        originalWindow: slot.window,
        items: quoteItems,
        quoteId: slot.quoteId,
      },
    });
    const promise = json?.data?.promises;
    if (!promise || typeof promise.id !== 'string') {
      throw new McpToolError('Harris Teeter did not return a reservation for that pickup window.', {
        hint: 'The window may have just filled — call ht_list_timeslots again and pick another.',
      });
    }
    return promise;
  }

  async getProfile(): Promise<Record<string, unknown> | undefined> {
    const json = await this.api<{ data?: { profile?: Record<string, unknown> } }>('GET', '/customer-profile/v1/profile');
    return json?.data?.profile;
  }

  /** Create the DRAFT checkout the site's "Place Order" page shows. Places nothing. */
  async createCheckout(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const json = await this.api<{ data?: { checkouts?: Record<string, unknown> | Record<string, unknown>[]; checkout?: Record<string, unknown> } }>(
      'POST',
      '/checkout/v1/checkouts',
      { laf: true, idempotent: true, body },
    );
    const c = json?.data?.checkouts ?? json?.data?.checkout;
    const checkout = Array.isArray(c) ? c[0] : c;
    if (!checkout) throw new McpToolError('Harris Teeter accepted the checkout request but returned no checkout.');
    return checkout;
  }

  async listCheckouts(): Promise<Record<string, unknown>[]> {
    const json = await this.api<{ data?: { checkouts?: Record<string, unknown>[] } }>('GET', '/checkout/v1/checkouts');
    return json?.data?.checkouts ?? [];
  }

  // ---- orders -----------------------------------------------------------

  async purchaseHistory(opts: { startDate: string; endDate: string; page?: number; pageSize?: number }) {
    const json = await this.api<{
      data?: { postOrderSearch?: { data?: Record<string, unknown>[]; isLastPage?: boolean; pageTotal?: number } };
    }>('GET', '/post-order/v1/purchase-history-search', {
      laf: true,
      query: {
        pageNo: opts.page ?? 1,
        pageSize: opts.pageSize ?? 10,
        startDate: opts.startDate,
        endDate: opts.endDate,
      },
    });
    const s = json?.data?.postOrderSearch;
    return { orders: s?.data ?? [], isLastPage: s?.isLastPage, pageTotal: s?.pageTotal };
  }
}

/** Cart line items, normalised. */
export function cartLines(cart: Record<string, unknown> | undefined): CartLine[] {
  const raw = Array.isArray(cart?.lineItems) ? (cart!.lineItems as Record<string, unknown>[]) : [];
  return raw
    .filter((l) => typeof l?.gtin13 === 'string' && l.savedForLater !== true)
    .map((l) => ({
      ...(typeof l.id === 'string' ? { id: l.id } : {}),
      upc: l.gtin13 as string,
      quantity: typeof l.quantity === 'number' ? l.quantity : 0,
      ...(typeof l.substitutionPolicy === 'string' ? { substitutionPolicy: l.substitutionPolicy } : {}),
    }));
}

/** Build StorePreferences from the modality-preferences record. */
export function extractPreferences(p: Record<string, unknown> | undefined): StorePreferences {
  const laf = p?.lafObject;
  if (!Array.isArray(laf) || laf.length === 0) {
    throw new McpToolError('Harris Teeter returned no store context for this account.', {
      hint: 'In the signed-in tab, choose a pickup store (the store picker at the top of harristeeter.com), then retry.',
    });
  }
  const modalities = Array.isArray(p?.modalities) ? (p!.modalities as Record<string, unknown>[]) : [];
  const primary = (p?.primaryModality ?? {}) as Record<string, string>;
  const pickup =
    modalities.find((m) => m.id === primary.PICKUP) ?? modalities.find((m) => m.modalityType === 'PICKUP');
  const dest = (pickup?.destination ?? {}) as Record<string, unknown>;
  const stores = Array.isArray(p?.storeDetails) ? (p!.storeDetails as Record<string, unknown>[]) : [];
  const locationId = typeof dest.locationId === 'string' ? dest.locationId : undefined;
  const store = stores.find((s) => s.locationId === locationId);
  const storeName = ((store?.address as Record<string, unknown>)?.address as Record<string, unknown>)?.name;
  const active = p?.activeModality;
  return {
    laf: JSON.stringify(laf),
    ...(locationId
      ? {
          pickup: {
            locationId,
            ...(typeof pickup?.fallbackFulfillment === 'string' ? { facilityId: pickup.fallbackFulfillment } : {}),
            ...(typeof storeName === 'string' ? { name: storeName } : {}),
          },
        }
      : {}),
    ...(typeof active === 'string' ? { activeModality: active } : {}),
  };
}

/** Map one atlas response to data or a typed error. */
export function parseAtlas<T>(status: number, body: string, path: string, url?: string): T {
  if (url && /login\.kroger\.com|\/signin/i.test(url)) throw new HtSignedOutError('redirected to sign-in');
  const trimmed = body.trimStart();
  let json: unknown;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = undefined;
    }
  }
  if (status === 401) throw new HtSignedOutError(`HTTP 401 on ${path.split('?')[0]}`);
  if (json === undefined) {
    if (status >= 400) throw new HtApiError(status, undefined, trimmed.slice(0, 80) || undefined, path);
    if (trimmed.startsWith('<')) {
      throw new McpToolError(`Harris Teeter returned a web page instead of data for ${path.split('?')[0]}.`, {
        hint: 'The tab may be signed out or showing a bot check. Reload https://www.harristeeter.com in the bridge browser, sign in if asked, then retry.',
        kind: 'edge_blocked',
      });
    }
    return undefined as T;
  }
  const errors = (json as { errors?: { code?: string; reason?: string } }).errors;
  if (status >= 400 || (errors && typeof errors === 'object' && !Array.isArray(errors) && errors.code)) {
    const code = errors?.code;
    if (code === 'UNAUTHORIZED' || code === 'AUTHENTICATION_REQUIRED') throw new HtSignedOutError(code);
    throw new HtApiError(status, code, errors?.reason, path);
  }
  return json as T;
}
