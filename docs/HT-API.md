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

## Savings, orders, recipes and lists (captured 2026-11-11)

Status: **live** = exercised through the built server against a real account;
**code** = taken from the site's bundles, not yet sent.

| Feature | Request | Notes | Status |
|---|---|---|---|
| Upcoming orders | `GET /atlas/v1/post-order/v1/pending-order-summaries` | needs `x-application-name` (any value; `400` without) → `data.pendingOrderSummaries.data[]` | live (empty: entry shape unseen) |
| Receipt detail | `POST /atlas/v1/purchase-history/v2/details` body `["<date>_<div>_<store>_<terminal>_<txn>"]` + `x-isreceipt: true` | the purchase list keys a receipt `div~store~date~terminal~txn`; reorder it. The site's own call adds `Akamai-BM-Telemetry` when available; without it the request worked once and later failed at the network layer ("Failed to fetch") while other POSTs still worked. Not worked around. | live, intermittent |
| Coupons | `GET /atlas/v1/savings-coupons/v2/coupons?filter.status=unclipped\|active&page.size&page.offset[&filter.searchString]` | `active` = clipped; `meta.coupons.userSavingsInfoByType.standard` has the counts | live |
| Clip / unclip | `POST /atlas/v1/savings-coupons/v1/clip-unclip` `{action:"CLIP"\|"UNCLIP", couponId}` | re-read to verify; round-tripped live | live |
| My Specials | `GET /atlas/v1/savings-coupons/v1/ht-specials` | `data.htSpecials[]` | live |
| Weekly ad | `GET /atlas/v1/savings-coupons/v1/ht-weekly-ads?filter.departmentNumber=N` | departmentNumber required; 1–18 answer (Produce … Beauty Care). The site's own weekly-ad page uses `api.kroger.com/digitalads` circulars instead — not needed. | live |
| Savings alerts | `GET /atlas/v1/savings-coupons/v1/ht-savings-alerts` | `400 HT_Savings HTTP_EXCEPTION` upstream for the test account — not exposed | — |
| Fuel points | `GET /atlas/v1/points/v1/program-summaries` | needs `user-time-zone` | live |
| Recipe search | `GET /atlas/v1/recipe/recipes?filter.query=…&page.offset&page.size` | `filter.keyword` is ignored | live |
| Recipe detail | `GET /atlas/v1/recipe/recipes/{id}?projections=recipes.full&filter.division=<3 digits>` | `400 MISSING_DIVISION` without the division | live |
| Shopping lists | `GET /atlas/v1/shopping-list/v1/shopping-lists[/{listId}?projections=shoppingLists.full]` | `data.shoppingLists` | live |
| List create / delete | `POST …/shopping-lists {name}`, `DELETE …/{listId}` | from the list-details bundle | code |
| List items | `PUT …/{listId} {name, versionKey, lineItems}` with lines `{id?, name, upc, type:"UPC", channel:"WEB", checked, quantity, comments}` | a free-text `{description, quantity}` line is accepted and silently dropped. Verified: full list + a new line adds it; a lone `quantity:0` line removes only itself. The tools always send the whole list. | live |

## Order Ahead (`/fresh/api`)

Deli counter, sandwich shop, pizzas, party/seafood platters, fruit baskets,
bakery, holiday meals. A separate app with its own headers: `X-Kroger-Tenant:
kroger` and `division: <DivisionCode>`, both from
`GET /fresh/api/v1/locationId/<locationId>` → `{DivisionCode, StoreNumber}`
(Harris Teeter: `HARR064`). Envelope `{Status:"success"|"failure", Data, Error}`.

- `GET /fresh/api/v2/ffo/stores/{store}/sections/Fresh/departmentGroups` — live
- `GET /fresh/api/v1/ffo/stores/{store}/departments/{_id}/products` — live
- `GET /fresh/api/v1/ffo/stores/{store}/product/{productId}?includePriceVaries=true` — live
- `POST /fresh/api/v2/ffo/stores/{store}/departments/timeslots` `{OrderDate, Items:[{DepartmentId}]}` → `["10:15 AM", …]` — live
- `POST /fresh/api/v4/ffo/stores/{store}/orders?includePriceVaries=true` — **code only.**
  Paid at pickup: no payment or fraud data in the body. The site PascalCases a
  camelCase body (`itemNumbers`→`Quantity`, `oneItemTotal`→`Price`,
  `topicId`→`DepartmentGroupId`, `upc`→`UPC`, `additionalComments`→`Note`) of
  `{departmentGroupWithOrderItems:[{orderItems, orderDate, timeSlot, ASAP}], …customer, OrderSource:"Web", GUID:"orderAheadWeb"}`.
  The cart is client-side only; the customer fields come from a checkout chunk
  not yet read; there is no cancel endpoint. `ht_oa_place_order` is gated and
  marked unverified until a real order is placed through it.

## Pharmacy (`/rx/api`, `/rx-security`)

Opening `harristeeter.com/rx` forces a **step-up sign-in with a one-time code**
(text or email). The resulting pharmacy session lasts about an hour
(`GET /rx-security/session` → `{active, sessionStatus:"AUTHORIZED", activeSecondsLeft}`);
every pharmacy tool checks it first and asks the user to re-verify when it lapses.

- `GET /rx/api/patient-profiles/` — patients; `patientNumber` is a 64-char hash — live
- `GET /rx/api/prescription/patient/prescriptions?patientNumber&includePaymentCards=false&deliveryEligibility=true`
  → `items[{rxNumber, drugName, primaryStatus, secondaryStatus, refillable, refillsRemainingCount, refillDueDate, lastRefillDate, promiseDateTime, patientPayAmount, prescriber, facility{vanityName, pharmacyHours}}]` — live.
  The compact view drops addresses, birth date, insurance and card fields.
- `GET /rx/api/banner/profile` → `{userId (96 chars), loyaltyCardNumber, …}` — live
- Refill: `POST /rx/api/orders-stage`
  `{userId, pickupTime:"<YYYY-MM-DDTHH:mm:ss±hh:mm in the pharmacy's zone>", orderType:"RETAIL", facilityId, rxRecords:[{rxNumber, rxRecordNumber, patientNumber}], paymentType:"POINT_OF_SALE", loyaltyNumber, orderRevenue, componentName:"checkout step 4"}`
  (RxCheckoutPage's RETAIL branch). **Code only** — `ht_rx_request_refill` is gated and says so.
  The site also keeps an rx cart (`/rx/api/cart`); whether staging requires it is unverified.
  Pay-at-pharmacy needs no payment data; "pay now" (`PAYSYS`) goes through the
  wallet and its fraud signals and stays out of scope.

## Bridge gotcha: pharmacy tabs swallow POSTs

When every open harristeeter.com tab is a `/rx/…` page, POSTs relayed through it
never answer (30 s bridge timeout) while GETs still work — so the store-context
call, and everything after it, stalls. Keep a regular harristeeter.com tab open.
A timed-out POST now carries that hint.
