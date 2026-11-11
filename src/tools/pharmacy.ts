import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations, minifiedResult, McpToolError } from '@chrischall/mcp-utils';
import type { HtClient } from '../client.js';
import { rxSession, patients, prescriptions } from '../api/rx.js';
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

export function registerPharmacyTools(server: McpServer, client: HtClient): void {
  server.registerTool(
    'ht_rx_session',
    {
      description:
        'Check whether the Harris Teeter pharmacy session is active. Pharmacy access needs a separate sign-in with a one-time code at harristeeter.com/rx and lasts about an hour.',
      annotations: toolAnnotations({ title: 'Pharmacy session', openWorld: true }),
      inputSchema: z.object({}),
      _meta: healthMeta('lookup'),
    },
    async () => {
      const s = await rxSession(client);
      return minifiedResult({
        ...s,
        ...(s.active ? {} : { next: 'Open https://www.harristeeter.com/rx/dashboard in the bridge browser and sign in (one-time code).' }),
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
}
