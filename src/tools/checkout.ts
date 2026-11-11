import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, minifiedResult, McpToolError, confirmWrite, confirmTokenParam, CONFIRM_FLOW_SENTENCE } from '@chrischall/mcp-utils';
import { cartLines, ORIGIN, type HtClient, type Timeslot, type TimeslotQuote } from '../client.js';
import { compactCheckout, usd } from '../project.js';
import { viewArg, viewResponse } from '../view.js';
import { foodMeta } from './hints.js';

type Rec = Record<string, unknown>;

/** Every slot, flattened, with the day label it was listed under. */
export function flattenSlots(quote: TimeslotQuote): (Timeslot & { dayLabel?: string })[] {
  return quote.days.flatMap((d) => (d.times ?? []).map((t) => ({ ...t, dayLabel: d.dayLabel })));
}

export function checkoutUrl(checkoutId: string): string {
  return `${ORIGIN}/checkout?nc=true&orderId=${encodeURIComponent(checkoutId)}`;
}

/** The phone number the site sends: `+1` and the last ten digits. */
function contactPhone(profile: Rec | undefined): string | undefined {
  const phones = Array.isArray((profile?.contactInfo as Rec)?.phones) ? ((profile!.contactInfo as Rec).phones as Rec[]) : [];
  for (const p of phones) {
    const digits = String((p.number as Rec)?.raw ?? (p.number as Rec)?.original ?? '').replace(/\D/g, '');
    if (digits.length >= 10) return `+1${digits.slice(-10)}`;
  }
  return undefined;
}

function contactEmail(profile: Rec | undefined): string | undefined {
  const emails = Array.isArray((profile?.contactInfo as Rec)?.emails) ? ((profile!.contactInfo as Rec).emails as Rec[]) : [];
  const verified = emails.find((e) => e.isVerified === true) ?? emails[0];
  return typeof verified?.address === 'string' ? verified.address : undefined;
}

export function registerCheckoutTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_list_timeslots',
    {
      description:
        'List available Harris Teeter pickup windows (next ~7 days) for what is in the cart now, with the fee for each. Pass a window to ht_start_checkout.',
      annotations: toolAnnotations({ title: 'List pickup times', openWorld: true }),
      inputSchema: z.object({ view: viewArg() }),
      _meta: foodMeta('lookup', { aliases: ['pickup times', 'pickup slots', 'grocery pickup'] }),
    },
    async ({ view }) => {
      const quote = await client.listTimeslots();
      return viewResponse(view, quote, (d) => ({
        slots: flattenSlots(d as TimeslotQuote).map((s) => ({
          window: s.window.value,
          day: s.dayLabel,
          time: s.displayString,
          timezone: s.window.timezone,
          fee: usd(s.cost),
        })),
        excludedItems: Object.values((d as TimeslotQuote).items).flatMap((i) => i.excluded ?? []).length,
      }));
    },
  );

  server.registerTool(
    'ht_get_checkout',
    {
      description:
        'Show the current Harris Teeter checkout draft — items, pickup window, coupons, fees, tax, total and payment card — plus the link to review and place it.',
      annotations: toolAnnotations({ title: 'Get checkout', openWorld: true }),
      inputSchema: z.object({ view: viewArg() }),
      _meta: foodMeta('lookup'),
    },
    async ({ view }) => {
      const checkouts = await client.listCheckouts();
      if (checkouts.length === 0) {
        return minifiedResult({ checkout: null, note: 'No checkout in progress. Use ht_start_checkout.' });
      }
      return viewResponse(view, checkouts, (d) =>
        (d as Rec[]).map((c) => compactCheckout(c, checkoutUrl(String(c.id))) ?? c),
      );
    },
  );

  server.registerTool(
    'ht_start_checkout',
    {
      description:
        'Reserve a Harris Teeter pickup window and create the checkout for the current cart. Returns the real totals (coupons, fees, tax) and a link; the order is NOT placed and nothing is charged — the user reviews it and presses "Place Order" on harristeeter.com. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Start checkout', readOnly: false, destructive: false, openWorld: true }),
      inputSchema: z.object({
        window: z
          .string()
          .min(10)
          .describe('The pickup window exactly as ht_list_timeslots returned it, e.g. "2026-11-12T22:00:00Z/2026-11-12T23:00:00Z".'),
        confirmToken: confirmTokenParam,
      }),
      _meta: foodMeta('change', { aliases: ['checkout', 'schedule pickup', 'place grocery order'] }),
    },
    async ({ window, confirmToken }, ctx: ServerContext) => {
      // Fresh reads on every call: the preview binds what would really be sent.
      const [cart, prefs, quote] = await Promise.all([client.getCart(), client.preferences(), client.listTimeslots()]);
      const lines = cartLines(cart);
      const slot = flattenSlots(quote).find((s) => s.window.value === window.trim());
      if (!slot) {
        throw new McpToolError(`Pickup window ${window} is not available for this cart.`, {
          hint: 'Call ht_list_timeslots and pass one of its windows verbatim.',
        });
      }
      const quoteItems = quote.items[slot.quoteId] ?? {};
      const excluded = quoteItems.excluded ?? [];
      const gate = await confirmWrite(ctx, {
        tool: 'ht_start_checkout',
        action: 'Reserve a pickup window and create a Harris Teeter checkout (does not place the order)',
        summary: `Pickup ${slot.dayLabel ?? ''} ${slot.displayString ?? slot.window.value} at ${prefs.pickup?.name ?? 'your store'} — ${lines.length} item line(s)`,
        account: undefined,
        target: prefs.pickup?.locationId,
        payload: {
          window: slot.window.value,
          vendorId: slot.vendorId,
          store: prefs.pickup?.locationId,
          lines: lines.map((l) => [l.upc, l.quantity, l.substitutionPolicy ?? null]),
        },
        preview: {
          store: prefs.pickup?.name ?? prefs.pickup?.locationId,
          pickupWindow: `${slot.dayLabel ?? ''} ${slot.displayString ?? ''}`.trim(),
          window: slot.window.value,
          fee: slot.cost,
          itemLines: lines.length,
          itemsUnavailableForThisWindow: excluded.length,
          placesOrder: false,
        },
        args: { window },
        confirmToken,
      });
      if (gate) return gate;

      const [promise, profile] = await Promise.all([
        client.reserveTimeslot(slot, quoteItems.included ?? []),
        client.getProfile(),
      ]);
      const selection = (Array.isArray(promise.selections) ? (promise.selections as Rec[]) : [])[0] ?? {};
      const included = (((selection.items as Rec)?.included as Rec[]) ?? (quoteItems.included as Rec[]) ?? []);
      const selExcluded = ((selection.items as Rec)?.excluded as Rec[]) ?? excluded;
      const byUpc = new Map(lines.map((l) => [l.upc, l]));
      const body = {
        buyer: {
          profileId: String(profile?.id ?? '').replace(/[{}]/g, ''),
          email: contactEmail(profile),
          loyaltyId: profile?.loyaltyCardNumber,
        },
        fulfillment: {
          contact: {
            firstName: profile?.firstName,
            lastName: profile?.lastName,
            phone: contactPhone(profile),
            smsOptin: false,
          },
          promise: { id: promise.id },
        },
        lineItems: included.map((i) => {
          const line = byUpc.get(String(i.gtin13));
          return {
            cart: {
              gtin13: i.gtin13,
              quantity: i.quantity,
              substitutionPolicy: line?.substitutionPolicy ?? 'SHOPPER_CHOICE',
              ...(line?.id ? { id: line.id } : {}),
            },
            requestedBy: 'CUSTOMER',
          };
        }),
        modalityType: 'PICKUP',
        cartId: cart?.id,
        properties: {
          createOrderPromiseHadFallout: selExcluded.length > 0 ? 'true' : 'false',
          checkoutVersion: '2',
          promisingVersion: '4',
        },
      };
      const checkout = await client.createCheckout(body);
      const url = checkoutUrl(String(checkout.id));
      return minifiedResult({
        ...(compactCheckout(checkout, url) ?? { checkoutId: checkout.id, placeOrderUrl: url }),
        ...(selExcluded.length ? { itemsNotIncluded: selExcluded } : {}),
        next: `Open ${url} in the browser to choose payment and press "Place Order". The pickup window is held for a limited time.`,
      });
    },
  );
}
