import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, minifiedResult, McpToolError, IsoDate, confirmWrite, confirmTokenParam, CONFIRM_FLOW_SENTENCE } from '@chrischall/mcp-utils';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { HtClient } from '../client.js';
import { rxSession, patients, prescriptions, rxProfile, stageRefill } from '../api/rx.js';
import { viewArg, viewResponse } from '../view.js';
import { healthMeta } from './hints.js';

type Rec = Record<string, unknown>;

/** Only what a person needs to manage refills — no address, DOB, insurance or card data. */
function compactRx(r: Rec) {
  const prescriber = (r.prescriber ?? {}) as Rec;
  const facility = (r.facility ?? {}) as Rec;
  return {
    rxNumber: r.rxNumber,
    drug: r.drugName ?? (r.prescriptionProduct as Rec | undefined)?.drugName,
    status: r.primaryStatus,
    detail: r.secondaryStatus || undefined,
    refillable: r.refillable,
    refillsRemaining: r.refillsRemainingCount,
    refillDue: r.refillDueDate,
    lastFilled: r.lastRefillDate,
    readyBy: r.promiseDateTime || undefined,
    price: r.patientPayAmount,
    autoRefill: r.rxRefillProgram,
    requiresCallToDoctor: r.requiresCallToDoctor,
    prescriber: [prescriber.firstName, prescriber.lastName].filter(Boolean).join(' ') || undefined,
    pharmacy: facility.vanityName,
  };
}

/** "2026-11-13" + "3:30 PM" in an IANA zone → "2026-11-13T15:30:00-05:00" (the site's moment-tz format()). */
export function pharmacyPickupTime(date: string, time: string, timeZone: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time.trim());
  if (!m) throw new McpToolError(`Invalid pickup time "${time}" — use e.g. "3:30 PM".`);
  let h = Number(m[1]) % 12;
  if (m[3]!.toUpperCase() === 'PM') h += 12;
  const local = `${date}T${String(h).padStart(2, '0')}:${m[2]}:00`;
  // Offset of that wall-clock time in the zone: format the UTC guess back in the zone.
  const guess = new Date(`${local}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(guess)
      .map((p) => [p.type, p.value]),
  );
  const asZone = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offsetMin = Math.round((asZone - guess.getTime()) / 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function registerPharmacyTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_rx_session',
    {
      description:
        'Check whether the Harris Teeter pharmacy session is active. Pharmacy access needs a separate sign-in at harristeeter.com/rx (a one-time code on a browser it does not know) and lasts one hour from sign-in; it cannot be extended.',
      annotations: toolAnnotations({ title: 'Pharmacy session', openWorld: true }),
      inputSchema: z.object({}),
      _meta: healthMeta('lookup'),
    },
    async () => {
      const s = await rxSession(client);
      return minifiedResult({
        ...s,
        ...(s.active ? {} : { next: 'Open https://www.harristeeter.com/rx/dashboard in the bridge browser and sign in again (one-time code only on a new browser).' }),
      });
    },
  );

  server.registerTool(
    'ht_rx_list_prescriptions',
    {
      description:
        'List prescriptions at the Harris Teeter pharmacy — drug, Rx number, status (refillable, too soon, no refills), refills remaining, refill due date, last fill, price and prescriber. Needs an active pharmacy session (ht_rx_session).',
      annotations: toolAnnotations({ title: 'List prescriptions', openWorld: true }),
      inputSchema: z.object({
        patientNumber: z.string().regex(/^[A-Za-z0-9-]{1,128}$/).optional().describe('Only this family member (from a previous result); default: every patient on the account.'),
        view: viewArg(),
      }),
      _meta: healthMeta('lookup', { aliases: ['prescriptions', 'refills', 'pharmacy', 'my meds'] }),
    },
    async ({ patientNumber, view }) => {
      const people = await patients(client);
      const chosen = patientNumber ? people.filter((p) => String(p.patientNumber) === patientNumber) : people;
      if (patientNumber && chosen.length === 0) throw new McpToolError(`No patient ${patientNumber} on this account.`);
      const result = [];
      for (const p of chosen) {
        result.push({ patient: { patientNumber: p.patientNumber, firstName: p.firstName }, prescriptions: await prescriptions(client, String(p.patientNumber)) });
      }
      return viewResponse(view, result, (d) =>
        (d as { patient: Rec; prescriptions: Rec[] }[]).map((x) => ({ ...x, prescriptions: x.prescriptions.map(compactRx) })),
      );
    },
  );

  server.registerTool(
    'ht_rx_request_refill',
    {
      description:
        'Request a refill of a prescription for pickup at its Harris Teeter pharmacy, paid at the pharmacy. The pharmacy starts work on it and there is no cancel from here. Needs an active pharmacy session. NOT yet verified against a live refill: the first real request is the test. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Request prescription refill', readOnly: false, destructive: true, openWorld: true }),
      inputSchema: z.object({
        rxNumber: z.string().regex(/^\d{3,12}$/).describe('Rx number from ht_rx_list_prescriptions.'),
        pickupDate: IsoDate.describe('YYYY-MM-DD, today or later, during pharmacy hours.'),
        pickupTime: z.string().regex(/^\d{1,2}:\d{2}\s*(AM|PM)$/i).describe('e.g. "3:30 PM".'),
        confirmToken: confirmTokenParam,
      }),
      _meta: healthMeta('send', { aliases: ['refill prescription', 'order refill'] }),
    },
    async ({ rxNumber, pickupDate, pickupTime, confirmToken }, ctx: ServerContext) => {
      const people = await patients(client);
      let found: { rx: Rec; patientNumber: string } | undefined;
      for (const p of people) {
        const rx = (await prescriptions(client, String(p.patientNumber))).find((r) => String(r.rxNumber) === rxNumber);
        if (rx) {
          found = { rx, patientNumber: String(p.patientNumber) };
          break;
        }
      }
      if (!found) throw new McpToolError(`No prescription ${rxNumber} on this account.`, { hint: 'Use an rxNumber from ht_rx_list_prescriptions.' });
      const { rx, patientNumber } = found;
      if (rx.refillable !== true && rx.primaryStatus !== 'Refillable') {
        throw new McpToolError(`Prescription ${rxNumber} is not refillable now (${String(rx.primaryStatus ?? 'unknown status')}).`);
      }
      const facility = (rx.facility ?? {}) as Rec;
      const facilityId = String(rx.facilityId ?? facility.facilityId ?? '');
      const tz = typeof facility.timezoneId === 'string' ? facility.timezoneId : 'America/New_York';
      if (!facilityId) throw new McpToolError(`Prescription ${rxNumber} has no pharmacy to fill it at.`);
      const profile = await rxProfile(client);
      if (typeof profile.userId !== 'string') throw new McpToolError('The pharmacy profile has no user id; open harristeeter.com/rx/dashboard once and retry.');
      const order = {
        userId: profile.userId,
        pickupTime: pharmacyPickupTime(pickupDate, pickupTime, tz),
        orderType: 'RETAIL' as const,
        facilityId,
        rxRecords: [{ rxNumber: String(rx.rxNumber), rxRecordNumber: String(rx.rxRecordNumber), patientNumber }],
        paymentType: 'POINT_OF_SALE' as const,
        ...(typeof profile.loyaltyCardNumber === 'string' ? { loyaltyNumber: profile.loyaltyCardNumber } : {}),
        ...(typeof rx.patientPayAmount === 'number' ? { orderRevenue: rx.patientPayAmount } : {}),
        componentName: 'checkout step 4',
      };
      const drug = String(rx.drugName ?? (rx.prescriptionProduct as Rec | undefined)?.drugName ?? rxNumber);
      const gate = await confirmWrite(ctx, {
        tool: 'ht_rx_request_refill',
        action: 'Request a prescription refill (pay at the pharmacy)',
        summary: `Refill ${drug} (Rx ${rxNumber}) for pickup ${pickupDate} ${pickupTime} at ${String(facility.vanityName ?? 'the pharmacy')}`,
        account: undefined,
        target: rxNumber,
        request: { method: 'POST', path: '/rx/api/orders-stage', body: order },
        preview: {
          drug,
          rxNumber,
          pharmacy: facility.vanityName,
          pickup: `${pickupDate} ${pickupTime} (${tz})`,
          expectedCost: rx.patientPayAmount,
          paidAt: 'pharmacy pickup',
          refillsRemainingAfter: typeof rx.refillsRemainingCount === 'number' ? rx.refillsRemainingCount - 1 : undefined,
        },
        args: { rxNumber, pickupDate, pickupTime },
        confirmToken,
      });
      if (gate) return gate;
      const result = await stageRefill(client, order);
      // Re-read: the prescription's status should move off "Refillable".
      const after = (await prescriptions(client, patientNumber)).find((r) => String(r.rxNumber) === rxNumber);
      return minifiedResult({
        requested: true,
        drug,
        pickup: `${pickupDate} ${pickupTime}`,
        statusNow: after ? { status: after.primaryStatus, detail: after.secondaryStatus, readyBy: after.promiseDateTime } : undefined,
        result,
      });
    },
  );
}
