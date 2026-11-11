// Which Harris Teeter store bridge-free (Kroger API) search prices against.
//
// Resolution, highest first:
//   1. a per-call zip / locationId on the tool;
//   2. the user's saved choice (ht_set_store);
//   3. HARRISTEETER_LOCATION_ID;
//   4. the browser's store as last remembered — saved whenever the bridge
//      reads the store context, so it follows a change made on the site;
//   5. the browser's live store, read through the bridge.
// (4) sits above (5) on purpose: asking a closed browser costs a 30 s bridge
// timeout, and the remembered copy is refreshed on every bridge read anyway.
//
// State lives in its own file (never the bridge identity's), 0600 in a 0700
// directory: $HARRISTEETER_STATE_DIR, else ~/.harristeeter-mcp.

import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpToolError, readEnvVar, writeFileSafe } from '@chrischall/mcp-utils';
import { configuredLocationId, type KrogerApi } from './api/kroger.js';

export interface StoreRecord {
  locationId: string;
  name?: string;
  updatedAt: string;
}

interface StoreFile {
  chosen?: StoreRecord;
  rememberedFromBrowser?: StoreRecord;
}

export type StoreSource = 'call' | 'saved' | 'env' | 'remembered-browser' | 'browser';

export interface ResolvedStore {
  locationId: string;
  name?: string;
  source: StoreSource;
}

const LOCATION_RE = /^\d{8}$/;

export function stateDir(): string {
  return readEnvVar('HARRISTEETER_STATE_DIR') ?? join(homedir(), '.harristeeter-mcp');
}

function storePath(): string {
  return join(stateDir(), 'store.json');
}

export function readStoreFile(): StoreFile {
  try {
    const j = JSON.parse(readFileSync(storePath(), 'utf8')) as StoreFile;
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

async function writeStoreFile(f: StoreFile): Promise<void> {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  await writeFileSafe(storePath(), new TextEncoder().encode(JSON.stringify(f)), { overwrite: true, mode: 0o600 });
}

/** Save (or with `null`, clear) the user's explicit store choice. */
export async function saveChosenStore(rec: { locationId: string; name?: string } | null): Promise<void> {
  const f = readStoreFile();
  if (rec === null) delete f.chosen;
  else f.chosen = { locationId: rec.locationId, ...(rec.name ? { name: rec.name } : {}), updatedAt: new Date().toISOString() };
  await writeStoreFile(f);
}

/** Remember the browser's store; a no-op write when it has not changed. Never throws. */
export async function rememberBrowserStore(rec: { locationId: string; name?: string }): Promise<void> {
  try {
    const f = readStoreFile();
    if (f.rememberedFromBrowser?.locationId === rec.locationId && f.rememberedFromBrowser?.name === rec.name) return;
    f.rememberedFromBrowser = { locationId: rec.locationId, ...(rec.name ? { name: rec.name } : {}), updatedAt: new Date().toISOString() };
    await writeStoreFile(f);
  } catch (err) {
    // Remembering is an optimisation; a read-only $HOME must not fail the tool.
    process.stderr.write(`[harristeeter-mcp] could not remember the browser store: ${(err as Error).message}\n`);
  }
}

/** Turn a per-call or ht_set_store request into a concrete store. */
export async function lookupStore(
  kroger: KrogerApi,
  req: { zip?: string; locationId?: string; name?: string },
): Promise<{ locationId: string; name?: string }> {
  if (req.locationId) {
    if (!LOCATION_RE.test(req.locationId)) {
      throw new McpToolError(`"${req.locationId}" is not an 8-digit store location id.`, { hint: 'Use ht_find_stores to look one up.' });
    }
    return { locationId: req.locationId };
  }
  if (req.zip) {
    const stores = await kroger.findStores(req.zip, 20);
    if (stores.length === 0) throw new McpToolError(`No Harris Teeter stores found near ${req.zip}.`);
    const wanted = req.name?.trim().toLowerCase();
    const pick = wanted ? stores.find((s) => String(s.name ?? '').toLowerCase().includes(wanted)) : stores[0];
    if (!pick) {
      throw new McpToolError(`No store near ${req.zip} matches "${req.name}".`, {
        hint: `Stores near ${req.zip}: ${stores.map((s) => String(s.name)).join('; ')}.`,
      });
    }
    return { locationId: String(pick.locationId), ...(typeof pick.name === 'string' ? { name: pick.name } : {}) };
  }
  throw new McpToolError('Give a zip (optionally with part of the store name) or an 8-digit locationId.');
}

/**
 * The store for bridge-free search. `liveBrowser` reads the bridge (and is
 * only tried last); it returns undefined when the bridge has no store.
 */
export async function resolveStore(
  kroger: KrogerApi,
  perCall: { zip?: string; locationId?: string },
  liveBrowser: () => Promise<{ locationId: string; name?: string } | undefined>,
): Promise<ResolvedStore> {
  if (perCall.zip || perCall.locationId) return { ...(await lookupStore(kroger, perCall)), source: 'call' };
  const f = readStoreFile();
  if (f.chosen) return { locationId: f.chosen.locationId, ...(f.chosen.name ? { name: f.chosen.name } : {}), source: 'saved' };
  const env = configuredLocationId();
  if (env) return { locationId: env, source: 'env' };
  if (f.rememberedFromBrowser) {
    const r = f.rememberedFromBrowser;
    return { locationId: r.locationId, ...(r.name ? { name: r.name } : {}), source: 'remembered-browser' };
  }
  const live = await liveBrowser();
  if (live) return { ...live, source: 'browser' };
  throw new McpToolError('No store to price against.', {
    hint: 'Pick one with ht_set_store (by ZIP or location id), or open harristeeter.com once in the bridge browser.',
  });
}
