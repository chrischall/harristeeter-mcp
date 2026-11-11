// Pharmacy (/rx/api, /rx-security). A separate, step-up session: opening
// harristeeter.com/rx asks the user to sign in again with a one-time code, and
// the resulting pharmacy session lasts about an hour (activeSecondsLeft). Every
// call checks it first so an expired session reads as "re-verify", not as an
// opaque error.

import { McpToolError } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';

type Rec = Record<string, unknown>;

export class RxSessionError extends McpToolError {
  constructor(detail: string) {
    super(`The Harris Teeter pharmacy session is not active (${detail}).`, {
      hint: 'Open https://www.harristeeter.com/rx/dashboard in the bridge browser and sign in again (it asks for a one-time code). The pharmacy session lasts about an hour.',
      kind: 'session_expired',
      status: 401,
    });
    this.name = 'RxSessionError';
  }
}

async function rxGet(client: HtClient, path: string, query?: Record<string, string>): Promise<unknown> {
  const r = await client.raw('GET', path, query ? { query } : {});
  if (r.status === 401 || r.status === 403) throw new RxSessionError(`HTTP ${r.status}`);
  if (r.json === undefined) {
    if (r.text.trimStart().startsWith('<')) throw new RxSessionError('the pharmacy returned its sign-in page');
    throw new McpToolError(`Pharmacy returned ${r.status} with no data for ${path}.`, { status: r.status, kind: 'http' });
  }
  if (r.status >= 400) {
    const msg = (r.json as Rec)?.message ?? (r.json as Rec)?.error;
    throw new McpToolError(`Pharmacy API ${r.status} on ${path}${msg ? `: ${String(msg)}` : ''}`, { status: r.status, kind: 'http' });
  }
  return r.json;
}

export interface RxSession {
  active: boolean;
  status?: string;
  secondsLeft?: number;
}

export async function rxSession(client: HtClient): Promise<RxSession> {
  const j = (await rxGet(client, '/rx-security/session')) as Rec;
  return {
    active: j?.active === true && j?.sessionStatus === 'AUTHORIZED',
    ...(typeof j?.sessionStatus === 'string' ? { status: j.sessionStatus } : {}),
    ...(typeof j?.activeSecondsLeft === 'number' ? { secondsLeft: j.activeSecondsLeft } : {}),
  };
}

async function requireRxSession(client: HtClient): Promise<void> {
  const s = await rxSession(client);
  if (!s.active) throw new RxSessionError(s.status ?? 'not authorized');
}

export async function patients(client: HtClient): Promise<Rec[]> {
  await requireRxSession(client);
  return ((await rxGet(client, '/rx/api/patient-profiles/')) as Rec[]) ?? [];
}

export async function prescriptions(client: HtClient, patientNumber: string): Promise<Rec[]> {
  await requireRxSession(client);
  if (!/^[A-Za-z0-9-]{1,128}$/.test(patientNumber)) throw new McpToolError(`Invalid patient number "${patientNumber}".`);
  const j = (await rxGet(client, '/rx/api/prescription/patient/prescriptions', {
    patientNumber,
    includePaymentCards: 'false',
    deliveryEligibility: 'true',
  })) as { items?: Rec[] };
  return j?.items ?? [];
}

/** The pharmacy customer record: carries the userId and loyalty number a refill order needs. */
export async function rxProfile(client: HtClient): Promise<Rec> {
  await requireRxSession(client);
  return ((await rxGet(client, '/rx/api/banner/profile')) as Rec) ?? {};
}

export interface RefillOrder {
  userId: string;
  pickupTime: string;
  orderType: 'RETAIL';
  facilityId: string;
  rxRecords: { rxNumber: string; rxRecordNumber: string; patientNumber: string }[];
  paymentType: 'POINT_OF_SALE';
  loyaltyNumber?: string;
  orderRevenue?: number;
  componentName: string;
}

/**
 * Stage a pay-at-pharmacy refill (RxCheckoutPage's RETAIL branch, from the
 * site's code — not yet verified against a live refill). "Pay now" goes
 * through the wallet and its fraud signals, so it is deliberately not offered.
 */
export async function stageRefill(client: HtClient, order: RefillOrder): Promise<unknown> {
  await requireRxSession(client);
  const r = await client.raw('POST', '/rx/api/orders-stage', { body: order });
  if (r.status === 401 || r.status === 403) throw new RxSessionError(`HTTP ${r.status}`);
  if (r.status >= 400 || r.json === undefined) {
    const msg = (r.json as Rec | undefined)?.message ?? r.text.slice(0, 160);
    throw new McpToolError(`Pharmacy refused the refill (${r.status}): ${String(msg)}`, { status: r.status, kind: 'http' });
  }
  return r.json;
}
