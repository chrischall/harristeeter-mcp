// Every test gets a fresh, empty state dir — never the real ~/.harristeeter-mcp.
import { beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ht-state-'));
  process.env.HARRISTEETER_STATE_DIR = dir;
});
afterEach(() => {
  if (dir && dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  delete process.env.HARRISTEETER_STATE_DIR;
});
