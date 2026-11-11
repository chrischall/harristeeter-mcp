/**
 * Context-group hints, published on each tool as `_meta.mint` (the mcp-host
 * context-groups contract, `mintHintSchema`). Inert data to any other client.
 * The shape is fixed by the host's contract, so it is restated here rather
 * than imported — this server takes no dependency on mcp-host.
 *
 * Grocery tools sit in the `food` group; the pharmacy tools in `health`.
 * No read is canonical yet: upcoming orders and refill status have not been
 * observed with real data, and a canonical read needs a verified brief view.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'food' | 'health';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

export function foodMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'food', intent, ...extra } };
}

export function healthMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'health', intent, ...extra } };
}
