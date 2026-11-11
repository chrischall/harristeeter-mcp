import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// End-to-end boot guard. Unit tests mock the transport, so they cannot catch
// the two failures that actually ship broken: an eager top-level import of an
// esbuild-externalized dep (which throws ERR_MODULE_NOT_FOUND the moment a host
// spawns the bundle, before it answers `initialize`), and a `bin` pointing at a
// path the build never emits. This spawns the REAL built artifact and runs the
// handshake an MCP host runs at install time.
//
// package.json `bin` is dist/bundle.js — the build is `tsc --noEmit` plus
// esbuild, so there is no separate tsc-emitted entrypoint to test.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');

beforeAll(() => {
  if (!existsSync(BUNDLE)) {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  }
}, 120_000);

/** Spawn the stdio server, run initialize + tools/list, resolve the tool names. */
function listToolsViaStdio(entry: string, cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [entry], {
      cwd,
      env: {
        ...process.env,
        // Keep the boot test off the shared fleet concentrator port (37149) so
        // it can never disturb — or be disturbed by — a real bridge running on
        // this machine.
        HARRISTEETER_WS_PORT: '39731',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out; stderr:\n${err}`));
    }, 15_000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] } };
        try {
          msg = JSON.parse(t);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve((msg.result.tools ?? []).map((x) => x.name));
          return;
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    // 'close' rather than 'exit' so stdout is fully drained first.
    child.on('close', (code) => {
      if (!out.includes('"id":1')) {
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}) before tools/list; stderr:\n${err}`));
      }
    });

    child.stdin.write(
      '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"boot-test","version":"1"}}}\n'
    );
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  });
}

// Lower bound, not an exact count: PR CI runs the branch merged with main, so a
// hardcoded count breaks the moment another PR adds a tool.
const MIN_TOOLS = 5;

describe('server boot (built artifact)', () => {
  it('boots WITHOUT node_modules and lists its tools', async () => {
    // A fresh dir holding only the bundle — the .mcpb runtime, where an eager
    // import of an externalized dep would fail to resolve.
    const dir = mkdtempSync(join(tmpdir(), 'harristeeter-mcpb-'));
    try {
      copyFileSync(BUNDLE, join(dir, 'bundle.js'));
      const tools = await listToolsViaStdio(join(dir, 'bundle.js'), dir);
      expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
      expect(tools).toContain('ht_healthcheck');
      expect(tools).toContain('ht_search_products');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('boots with no credentials configured', async () => {
    // harristeeter-mcp needs none — every call rides the browser tab's own
    // signed-in session — so the server must come up cleanly in a bare
    // environment rather than demanding configuration.
    const tools = await listToolsViaStdio(BUNDLE, ROOT);
    expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
  }, 30_000);
});
