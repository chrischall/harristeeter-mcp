---
name: harristeeter-fpx
description: Shop Harris Teeter from a shell — search groceries with prices and pickup stock at your store, read and change the cart, list pickup windows, see the checkout draft and past orders — through the user's signed-in harristeeter.com tab with the fpx CLI. Use when asked to find Harris Teeter products or prices, build a grocery cart, check pickup times, or look up Harris Teeter orders without running harristeeter-mcp.
---

# Harris Teeter via fpx

harristeeter.com (Kroger's platform) answers only a real browser — Akamai resets
any server-side connection — so every call goes through the user's signed-in tab
with `fpx` (`@fetchproxy/cli`) and the ContextMint Bridge extension.

## One-time setup

```sh
npm i -g @fetchproxy/cli
fpx profile add harristeeter --domain harristeeter.com
fpx profile declare harristeeter --allow-in-page
scripts/ht store        # first call prints a pair code on stderr — approve it in ContextMint Bridge
```

Keep a signed-in https://www.harristeeter.com tab open. If a second browser also
runs ContextMint Bridge, stderr shows a fresh pair code on every call while the
call still succeeds — do not approve those; it is the other browser being turned
away (`fpx trust list` shows which browser the profile pinned).

## Use `scripts/ht`

```sh
scripts/ht search "2% milk" 5     # upc, description, brand, size, price, salePrice, pickupStock
scripts/ht cart                   # cart lines with names and prices
scripts/ht add 0000000094011 2    # add 2 to whatever is in the cart
scripts/ht set 0000000094011 1    # absolute quantity; 0 removes
scripts/ht remove 0000000094011
scripts/ht timeslots              # pickup windows + fees for the current cart
scripts/ht checkout               # checkout draft(s): window, total, link
scripts/ht orders 180             # purchase history, last N days
scripts/ht store                  # pickup store + store context
```

Rules:
- **Resolve before you write.** Get UPCs from `search`; never guess one. UPCs are
  13 digits with leading zeros (`ht` pads shorter ones).
- **Re-read after a write.** `add`/`set`/`remove` print the cart re-read; check the
  line actually moved — an unavailable item can be silently dropped.
- **No checkout or ordering from the shell.** Creating the checkout reserves a
  pickup window and is confirmation-gated in harristeeter-mcp (`ht_start_checkout`);
  placing the order is always the user pressing "Place Order" on
  https://www.harristeeter.com/checkout — the payment step carries fraud and
  bot-detection signals only the real page produces.

Exit codes: `0` ok · `1` usage / not signed in / no store chosen · `2` bridge down ·
`3` bot wall · `4` upstream HTTP error (the API's code and reason go to stderr).

Raw request shapes (headers, bodies, the store-context `x-laf-object`) are in
`references/requests.md`.

## In context groups

harristeeter-mcp is in the **food** group. None of its reads is canonical (no
what's-new/due/on answer), so "anything due…?" asks do not reach it; ask for
Harris Teeter by name. As a browser-bridged MCP, the group answers "needs your
browser open" when the tab or extension is not available.
