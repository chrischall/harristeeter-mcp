/**
 * Context-group hints, published on each tool as `_meta.mint` (the mcp-host
 * context-groups contract, `mintHintSchema`). Inert data to any other client.
 * The shape is fixed by the host's contract, so it is restated here rather
 * than imported — this server takes no dependency on mcp-host.
 *
 * harristeeter-mcp sits in the `food` group. Nothing here answers a
 * what's-new / what's-due / what's-on question (there is no read for an
 * upcoming pickup yet), so no tool is canonical and none names a subject.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'food';
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
