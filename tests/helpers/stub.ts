import type { HtTransport, FetchInit, FetchResult } from '../../src/transport.js';
import { HtClient } from '../../src/client.js';

export type Route = (init: FetchInit, parsed: { path: string; query: URLSearchParams; body: unknown }) => FetchResult | unknown;

/** A scripted transport. A handler may return a FetchResult or a plain JSON value (sent as a 200). */
export function stubTransport(handler: Route) {
  const calls: FetchInit[] = [];
  const transport: HtTransport = {
    start: async () => {},
    close: async () => {},
    status: () => ({}),
    runProbe: async () => ({}),
    fetch: async (init) => {
      calls.push(init);
      const u = new URL(init.path, 'https://www.harristeeter.com');
      const out = handler(init, {
        path: u.pathname,
        query: u.searchParams,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      const isRaw =
        out && typeof out === 'object' && Object.keys(out).length > 0 &&
        Object.keys(out).every((k) => ['status', 'body', 'url'].includes(k));
      return isRaw ? (out as FetchResult) : { status: 200, body: JSON.stringify(out) };
    },
  };
  return { transport, calls };
}

/** Synthetic fixtures — no real account values. */
export const PREFS = {
  data: {
    modalityPreferences: {
      activeModality: 'PICKUP',
      lafObject: [{ modality: { type: 'PICKUP' }, sources: [{ storeId: '00000', facilityId: '00001' }] }],
      primaryModality: { PICKUP: 'mod-pickup' },
      modalities: [
        { id: 'mod-pickup', modalityType: 'PICKUP', destination: { locationId: '09700000' }, fallbackFulfillment: '09700000' },
      ],
      storeDetails: [{ locationId: '09700000', address: { address: { name: 'Test Store' } } }],
    },
  },
};

export const CART = {
  data: {
    carts: [
      {
        id: 'cart-1',
        lineItems: [
          { id: 'line-a', gtin13: '0000000000011', quantity: 2, substitutionPolicy: 'SHOPPER_CHOICE' },
          { id: 'line-b', gtin13: '0000000000022', quantity: 1, substitutionPolicy: 'NONE' },
        ],
      },
    ],
  },
};

export function product(upc: string, description: string, price: string) {
  return {
    item: { upc, description, brand: { name: 'Brand' }, customerFacingSize: '1 ct' },
    price: { storePrices: { regular: { price } } },
    inventorySummaries: [{ modalityType: 'PICKUP', stockLevel: 'HIGH' }],
  };
}

export const SLOT = {
  optionId: 'opt-1',
  quoteId: 'q-1',
  vendorId: 'v-1',
  vendorName: 'KROGER',
  cost: 'USD 4.95',
  window: { value: '2030-01-01T22:00:00Z/2030-01-01T23:00:00Z', timezone: 'America/New_York' },
  displayString: '5:00 - 6:00 PM',
  type: 'STANDARD',
};

export const TIMESLOTS = {
  data: {
    timeslots: {
      days: [{ dayLabel: 'Tomorrow', times: [SLOT] }],
      items: {
        'q-1': {
          included: [
            { gtin13: '0000000000011', quantity: 2, productId: 'p1', source: { storeId: '00000', facilityId: '00001' } },
            { gtin13: '0000000000022', quantity: 1, productId: 'p2', source: { storeId: '00000', facilityId: '00001' } },
          ],
          excluded: [],
        },
      },
    },
  },
};

export function makeClient(handler: Route) {
  const { transport, calls } = stubTransport(handler);
  return { client: new HtClient({ transport, timeZone: 'America/New_York' }), calls };
}
