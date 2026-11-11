// Compact projections over documented atlas fields only. Each returns
// undefined when the record does not have the shape it reads, so the view kit
// hands back the raw record instead of a half-empty one.

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** "USD 4.69" → 4.69 */
export function usd(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = /(-?\d+(?:\.\d+)?)/.exec(s);
  return m ? Number(m[1]) : undefined;
}

export interface CompactProduct {
  upc: string;
  description?: string;
  brand?: string;
  size?: string;
  price?: number;
  salePrice?: number;
  unitPrice?: string;
  pickupStock?: string;
  maxQuantity?: number;
}

export function compactProduct(p: Rec): CompactProduct | undefined {
  const item = rec(p.item);
  const upc = str(item.upc) ?? str(p.upc) ?? str(p.id);
  if (!upc || !item.description) return undefined;
  const store = rec(rec(p.price).storePrices);
  const regular = rec(store.regular);
  const promo = rec(store.promo);
  const pickupSummary = (Array.isArray(p.fulfillmentSummaries) ? (p.fulfillmentSummaries as Rec[]) : []).find(
    (f) => f.type === 'PICKUP',
  );
  const pickupInv = (Array.isArray(p.inventorySummaries) ? (p.inventorySummaries as Rec[]) : []).find(
    (i) => i.modalityType === 'PICKUP',
  );
  const eq = rec(regular.equivalizedUnitPrice);
  const out: CompactProduct = {
    upc,
    description: str(item.description),
    brand: str(rec(item.brand).name),
    size: str(item.customerFacingSize),
    price: usd(regular.price),
    salePrice: usd(promo.price),
    unitPrice: eq.amount !== undefined ? `${eq.amount} ${eq.denomination === 'CENT' ? '¢' : ''} ${str(eq.unit) ?? ''}`.replace(/\s+/g, ' ').trim().toLowerCase() : undefined,
    pickupStock: str(pickupInv?.stockLevel),
    maxQuantity: typeof pickupSummary?.maxOrderQuantity === 'number' ? pickupSummary.maxOrderQuantity : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as unknown as CompactProduct;
}

export interface CompactSlot {
  optionId: string;
  day?: string;
  time?: string;
  window: string;
  fee?: number;
}

export function compactCheckout(c: Rec, url: string): Rec | undefined {
  const summary = rec(c.summary);
  const cost = rec(summary.cost);
  if (!str(c.id)) return undefined;
  const sel = (Array.isArray(rec(rec(c.fulfillment).promise).selections)
    ? (rec(rec(c.fulfillment).promise).selections as Rec[])
    : [])[0];
  const lines = Array.isArray(c.lineItems) ? (c.lineItems as Rec[]) : [];
  return {
    checkoutId: c.id,
    status: str(c.status),
    modality: str(c.modalityType),
    pickupWindow: str(rec(sel?.window).value),
    pickupWindowTimezone: str(rec(sel?.window).timezone),
    itemCount: typeof summary.itemCount === 'number' ? summary.itemCount : lines.length,
    items: lines.map((l) => {
      const cart = rec(l.cart);
      const product = rec(cart.product);
      return {
        upc: str(cart.gtin13),
        description: str(product.krogerOwnedEcommerceDescription) ?? str(product.customerFacingSize),
        quantity: cart.quantity,
        substitutionPolicy: str(cart.substitutionPolicy),
      };
    }),
    totals: {
      items: usd(cost.itemTotal),
      coupons: usd(cost.couponTotal),
      discounts: usd(cost.discountTotal),
      fees: usd(cost.feeTotal),
      tax: usd(cost.taxTotal),
      total: usd(cost.total),
    },
    paymentMethods: (Array.isArray(rec(c.paymentDetails).paymentMethods)
      ? (rec(c.paymentDetails).paymentMethods as Rec[])
      : []
    ).map((m) => ({ type: str(m.type), brand: str(m.brand) ?? str(m.cardType), last4: str(m.lastFourPan) })),
    placeOrderUrl: url,
  };
}
