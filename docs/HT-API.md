# Harris Teeter web API (as used by harristeeter-mcp)

harristeeter.com runs on Kroger's web platform. Its JSON API lives under
`https://www.harristeeter.com/atlas/v1/…` and is fronted by Akamai Bot Manager:
a request from a server (curl, Node) is reset at the HTTP/2 layer before any
response, so **every call runs inside the user's signed-in browser tab** via the
fetchproxy bridge. The session is the tab's cookies; this server holds no
credential.

Shapes below were captured from the live site on 2026-11-11 (a signed-in tab,
in-page fetch, and the site's own JS bundles). Only structure is recorded —
never a captured value.

## Headers

| Header | When | Without it |
|---|---|---|
| `x-kroger-channel: WEB` | every call (uppercase) | `400 MISSING_CHANNEL` (`web` → `invalid_channel`) |
| `x-laf-object` | search, products, cart write, timeslots, promises, checkout, history | `400 LAF_OBJECTS_REQUIRED` |
| `user-time-zone` (IANA) | timeslots, promises | `400 MISSING_TIMEZONE_HEADER` |
| `x-idempotency-key` (uuid) | timeslots, create checkout | sent by the site; optional |

`x-laf-object` ("location-aware fulfillment") is `JSON.stringify(lafObject)` from
the store-context call below — the site's own `getLAFHeader` selector does exactly
this. The site also sends `x-modality`, `x-modality-type`, `x-facility-id`,
`x-call-origin` and `x-ab-test`; none were required (verified by replaying with
only the three headers above).

## Store context

`POST /atlas/v1/modality/preferences?filter.restrictLafToFc=true`, body `{}`
(a GET answers `405`) →
`data.modalityPreferences { activeModality, lafObject[], primaryModality{PICKUP,DELIVERY,IN_STORE},
modalities[{id, modalityType, destination{locationId}, fallbackFulfillment}], storeDetails[{locationId, address.address.name}] }`.
`locationId` is division + store, 8 digits.

## Reads

- `GET /atlas/v1/search/v1/products-search?filter.query=<q>&filter.locationId=<loc>&filter.fulfillmentMethods=PICKUP&page.size&page.offset&option.monetization=NONE`
  → `data.productsSearch[{upc, description, brandName}]`, `meta.productsSearch.totalCount`.
  `filter.keyword` returns 0 results; `filter.query` is what the site sends.
  Fulfilment values: `IN_STORE | PICKUP | DELIVERY | SHIP`.
- `GET /atlas/v1/product/v2/products?filter.gtin13s=<upc>…&filter.verified=true&projections=items.full`
  → `data.products[{item{upc, description, brand.name, customerFacingSize}, price.storePrices{regular,promo}{price:"USD x.yy", equivalizedUnitPrice}, inventorySummaries[{modalityType, stockLevel}], fulfillmentSummaries[{type, maxOrderQuantity}]}]`.
  `items.compact` has no price.
- `GET /atlas/v1/carts` → `data.carts[{id, versionKey, lineItems[{id, gtin13, quantity, substitutionPolicy, channel, modalityType, savedForLater}]}]`.
- `GET /atlas/v1/checkout/v1/checkouts` → `data.checkouts[{id, status:"DRAFT", modalityType, fulfillment.promise.selections[{window}], lineItems[{cart{gtin13, quantity, product}}], summary{itemCount, cost{itemTotal, couponTotal, discountTotal, feeTotal, taxTotal, total}}, paymentDetails.paymentMethods[]}]`.
- `GET /atlas/v1/customer-profile/v1/profile` → `data.profile{id, firstName, lastName, loyaltyCardNumber, contactInfo{emails[], phones[{number{raw}}]}}`.
- `GET /atlas/v1/post-order/v1/purchase-history-search?pageNo&pageSize&startDate&endDate`
  → `data.postOrderSearch{data[{createdDateTime, purchaseType, status, total, lineItems[{upc}]}], isLastPage, pageTotal}`.

## Cart writes

`PUT /atlas/v1/carts/{cartId}` body `{ lineItems: [...] }` — **merge semantics**:
only the named lines change (verified: adding one item left the other line
untouched).

- add / set: `{ id?, gtin13, channel:"WEB", modalityType:"PICKUP", quantity, substitutionPolicy }`
- remove: `{ id, gtin13, quantity: 0, modalityType }`

`substitutionPolicy`: `SHOPPER_CHOICE` (site default) | `CUSTOMER_CHOICE` | `CONTACT_CUSTOMER` | `NONE`.
A 200 is not proof — the tools re-read the cart and report any line that did not move.

## Pickup + checkout (draft only)

1. `POST /atlas/v1/promising/v4/timeslots` body `{ items:[{gtin13, quantity}] }`
   → `data.timeslots{ days[{dayLabel, times[{optionId, quoteId, vendorId, vendorName, cost:"USD 4.95", window{value:"<iso>/<iso>", timezone}, displayString, storeId, type}]}], items{<quoteId>{included[{gtin13, quantity, productId, source{storeId, facilityId}}], excluded[]}} }`.
   Option/quote ids are per quote, so the MCP keys a slot by its `window.value`.
2. `POST /atlas/v1/promising/v4/promises/` (trailing slash) body
   `{ optionIds:[optionId], vendorId, originalWindow: window, items: <quote included>, quoteId }`
   → `data.promises{ id, expiration, selections[{window, items{included, excluded}}] }`.
3. `POST /atlas/v1/checkout/v1/checkouts` → `201`, a new DRAFT checkout. Body (site builder in
   `kroger-checkout-pages.*.js`):
   ```
   { buyer:{profileId (braces stripped), email, loyaltyId},
     fulfillment:{contact:{firstName, lastName, phone:"+1##########", smsOptin}, promise:{id}},
     lineItems:[{cart:{gtin13, quantity, substitutionPolicy, id}, requestedBy:"CUSTOMER"}],
     modalityType:"PICKUP", cartId,
     properties:{createOrderPromiseHadFallout:"true"|"false", checkoutVersion:"2", promisingVersion:"4"} }
   ```
   The checkout page is then `https://www.harristeeter.com/checkout?nc=true&orderId=<checkout id>`.

## Placing the order — deliberately not implemented

The site submits the order as `POST https://pay.harristeeter.com/payment/v1/checkouts/{checkoutId}`
from a hosted payment frame. That client attaches its own bearer token
(`/hw/auth/token`), `x-payment-auth-type`, and anti-fraud / bot-manager signals
(an Akamai `Akamai-BM-Telemetry` header and Accertify device data collected on
the checkout page). Sending that request from a server would mean manufacturing
those signals, so harristeeter-mcp stops at the draft and the user presses
**Place Order** in the browser.
Selecting a saved card (`PUT /atlas/v1/checkout/v1/checkouts/update/payment/{id}`)
needs a `paymentGram` from the same payment host, and is likewise left to the page.

Related endpoints seen but not used: `POST /atlas/v1/post-order/v1/cancel-order`,
`PUT /atlas/v1/checkout/v1/checkouts/update/lineitems/{id}`.
