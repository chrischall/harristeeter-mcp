import { describe, it, expect } from 'vitest';
import { FetchproxyTransport, RX_TAB_HINT } from '../src/transport-fetchproxy.js';

function timeoutError(): Error {
  const e = new Error('https://www.harristeeter.com/atlas/v1/x did not respond within 30000ms.');
  e.name = 'FetchproxyTimeoutError';
  return e;
}

function transportThatTimesOut() {
  const inner = { fetch: async () => { throw timeoutError(); } } as unknown as ConstructorParameters<typeof FetchproxyTransport>[0]['inner'];
  return new FetchproxyTransport({ version: '0.0.0', inner });
}

type HintedError = Error & { hint?: string; kind?: string };

/** The rejection, typed — and a failure if the call resolved instead. */
async function failure(p: Promise<unknown>): Promise<HintedError> {
  try {
    await p;
  } catch (e) {
    return e as HintedError;
  }
  throw new Error('expected the call to reject');
}

describe('FetchproxyTransport', () => {
  it('adds the pharmacy-tab hint to a POST that times out', async () => {
    const err = await failure(transportThatTimesOut().fetch({ method: 'POST', path: '/atlas/v1/x', body: '{}' }));
    expect(err).toBeInstanceOf(Error);
    expect(err.hint).toBe(RX_TAB_HINT);
    expect(err.kind).toBe('timeout');
  });

  it('leaves a GET timeout as the bridge reported it', async () => {
    const err = await failure(transportThatTimesOut().fetch({ method: 'GET', path: '/atlas/v1/x' }));
    expect(err.name).toBe('FetchproxyTimeoutError');
    expect(err.hint).toBeUndefined();
  });
});
