# harristeeter-mcp

Harris Teeter grocery pickup for Claude: search products with prices at your store, build the
cart, see open pickup windows, and start checkout. **You place the order yourself** on
harristeeter.com. The MCP stops at a draft checkout with the real totals and hands you the link.

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
| `ht_get_cart` | Cart with names, prices, estimated subtotal |
| `ht_add_to_cart` | Add items by UPC (adds to existing quantity) |
| `ht_update_cart_item` | Set quantity / substitution preference (0 removes) |
| `ht_remove_from_cart` | Remove items |
| `ht_get_store` | Your pickup store |
| `ht_list_timeslots` | Open pickup windows and fees for the cart |
| `ht_start_checkout` | **Confirmation-gated.** Reserve a window and create the checkout, returning totals and the place-order link |
| `ht_get_checkout` | The current checkout draft |
| `ht_list_orders` | Past purchases and receipts |
| `ht_healthcheck` | Bridge status |

Cart tools change only your cart and can be undone, so they run without confirmation.
`ht_start_checkout` reserves a pickup window, so it previews first and acts only when called
again with the returned `confirmToken`.

### Why it can't press "Place Order"

The site submits orders to a separate payment host from a hosted payment frame that attaches
its own token plus fraud-screening and bot-detection data. Sending that from a server would
mean faking those signals, so the final click stays with you. See [docs/HT-API.md](docs/HT-API.md).

## Configuration

| Variable | Default | |
|---|---|---|
| `HARRISTEETER_WS_PORT` | `37149` | fetchproxy concentrator port, shared by the whole fleet. Change only if you know why. |
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
