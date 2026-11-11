# harristeeter-mcp

Harris Teeter for Claude: search groceries with prices at your store, build the cart, pick a
pickup window and start checkout, clip digital coupons, read the weekly ad and your specials,
check fuel points and past receipts, find recipes, manage shopping lists, browse and order from
Order Ahead (deli, subs, pizza, platters), and check your prescriptions. **You place grocery orders
yourself** on harristeeter.com. The MCP stops at a draft checkout with the real totals and hands you the link.

> This project was developed and is maintained by AI (Claude Code). Use at your own discretion.

## How it reaches Harris Teeter

harristeeter.com is Kroger's web platform behind Akamai bot protection, and it answers
only a real browser. Every request therefore runs inside **your own signed-in harristeeter.com
tab** through the [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases)
extension (the fetchproxy bridge), reusing your session. There are no credentials to configure.

1. Install the ContextMint Bridge extension and sign in at https://www.harristeeter.com.
2. Add the server (below) and call `ht_healthcheck`.
3. Approve the pair code it shows in the extension popup, once.

If a second browser also runs ContextMint Bridge, stderr will show a fresh pair code on every
call even though the call succeeds. Don't approve those; that's the other browser being refused.

## Without the browser: Kroger's official API (optional)

Product search, prices and store lookup can run without the bridge through Kroger's official
API. Register an app at [developer.kroger.com](https://developer.kroger.com) and set
`KROGER_API_CLIENT_ID` and `KROGER_API_CLIENT_SECRET`. `ht_search_products`, `ht_get_products` and
`ht_find_stores` then call `api.kroger.com` directly, pricing against `HARRISTEETER_LOCATION_ID`
(use `ht_find_stores` to look it up) or the store chosen in your browser. Results have the same
fields either way and say which `source` served them; the API prices produce per pound, and each
API result says so. Everything else (cart,
checkout, coupons, lists, Order Ahead, pharmacy) still needs the bridge: Kroger's API sign-in
doesn't accept Harris Teeter accounts, so it can't act on your account.

## Install

```json
{
  "mcpServers": {
    "harristeeter": { "command": "npx", "args": ["-y", "@chrischall/harristeeter-mcp"] }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `ht_search_products` | Search at your pickup store: UPC, name, brand, size, price, sale price, unit price, stock |
| `ht_get_products` | Look up UPCs |
| `ht_find_stores` | Harris Teeter stores near a ZIP, with the 8-digit location id (needs Kroger API credentials) |
| `ht_get_cart` | Cart with names, prices, estimated subtotal |
| `ht_add_to_cart` | Add items by UPC (adds to existing quantity) |
| `ht_update_cart_item` | Set quantity / substitution preference (0 removes) |
| `ht_remove_from_cart` | Remove items |
| `ht_get_store` | Your pickup store |
| `ht_list_timeslots` | Open pickup windows and fees for the cart |
| `ht_start_checkout` | **Confirmation-gated.** Reserve a window and create the checkout, returning totals and the place-order link |
| `ht_get_checkout` | The current checkout draft |
| `ht_list_orders` | Past purchases and receipts (each with a `receiptKey`) |
| `ht_get_receipt` | One purchase in full: items, price paid, savings, totals |
| `ht_list_upcoming_orders` | Orders placed but not yet picked up |
| `ht_list_coupons` / `ht_clip_coupon` / `ht_unclip_coupon` | e-VIC digital coupons |
| `ht_list_specials` | Your personalised My Specials |
| `ht_get_weekly_ad` | This week's ad, by department or text |
| `ht_get_fuel_points` | Fuel points balance and expiry |
| `ht_search_recipes` / `ht_get_recipe` | Recipes, with store products matched to ingredients |
| `ht_list_shopping_lists` / `ht_get_shopping_list` / `ht_create_shopping_list` / `ht_rename_shopping_list` / `ht_delete_shopping_list` | Shopping lists (delete is confirmation-gated) |
| `ht_add_to_shopping_list` / `ht_remove_from_shopping_list` | Add or remove list items by UPC |
| `ht_oa_list_departments` / `ht_oa_list_menu` / `ht_oa_get_item` / `ht_oa_list_pickup_times` | Order Ahead menus and pickup times |
| `ht_oa_place_order` | **Confirmation-gated.** Place an Order Ahead order, paid at pickup. Not yet verified against a live order. |
| `ht_rx_session` / `ht_rx_list_prescriptions` | Pharmacy: session status, prescriptions, refills remaining, due dates |
| `ht_rx_request_refill` | **Confirmation-gated.** Request a refill, paid at the pharmacy. Not yet verified against a live refill. |
| `ht_healthcheck` | Bridge status |

Cart tools change only your cart and can be undone, so they run without confirmation.
`ht_start_checkout` reserves a pickup window, so it previews first and acts only when called
again with the returned `confirmToken`.

### Pharmacy needs its own sign-in

Opening harristeeter.com/rx asks you to sign in again (with a one-time code the first time on a
browser). Pharmacy access then lasts **one hour from sign-in**, and nothing extends it. When it
lapses the `ht_rx_*` tools say so; sign in again at https://www.harristeeter.com/rx/dashboard.
If a pharmacy tab is open when the hour ends, the site signs you out of harristeeter.com
entirely, so the grocery tools need a fresh sign-in too. Keep a regular harristeeter.com tab open as well, because
the bridge can't send some requests from a pharmacy page.

### Why it can't press "Place Order"

The site submits orders to a separate payment host from a hosted payment frame that attaches
its own token plus fraud-screening and bot-detection data. Sending that from a server would
mean faking those signals, so the final click stays with you. See [docs/HT-API.md](docs/HT-API.md).

## Configuration

| Variable | Default | |
|---|---|---|
| `HARRISTEETER_WS_PORT` | `37149` | fetchproxy concentrator port, shared by the whole fleet. Change only if you know why. |
| `KROGER_API_CLIENT_ID` / `KROGER_API_CLIENT_SECRET` | unset | Optional Kroger developer app: search and prices without the browser |
| `HARRISTEETER_LOCATION_ID` | your browser's store | 8-digit store id for bridge-free search |
| `HARRISTEETER_DEBUG` | unset | `1` for verbose bridge logging to stderr |
| `MCP_USER_TZ` | `America/New_York` | IANA zone sent with pickup-time requests |
| `MCP_CONFIRM_MODE` | `ask-user` | `ask-user` (the model must get your OK in chat before using a token), `auto`, or `refuse` |
| `MCP_CONFIRM_ELICITATION` | on | `off` skips the client's confirmation prompt even when it supports one |
| `MCP_CONFIRM_SECRET` | random per process | Fixed key for confirm tokens, so a token survives a restart |

## Skill

`skills/harristeeter-fpx` does the same reads and cart changes from a shell with the `fpx` CLI,
with no MCP server.

## License

MIT
