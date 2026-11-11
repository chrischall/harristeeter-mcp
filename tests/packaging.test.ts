import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// These only fail once a tag exists (npm provenance, a blank mcp-host wizard,
// a skill that never ships), so pin them here.
describe('packaging', () => {
  it('declares the repository provenance is checked against', () => {
    expect(pkg.repository.url).toBe('git+https://github.com/chrischall/harristeeter-mcp.git');
  });
  it('publishes publicly under the @chrischall scope', () => {
    expect(pkg.name).toBe('@chrischall/harristeeter-mcp');
    expect(pkg.publishConfig.access).toBe('public');
  });
  it('ships the skill and the hosting manifest in the npm tarball', () => {
    for (const f of ['dist', 'skills', 'mint.yaml', 'server.json', '.claude-plugin', '.mcp.json']) {
      expect(pkg.files, f).toContain(f);
    }
    expect(existsSync(new URL('../skills/harristeeter-fpx/SKILL.md', import.meta.url))).toBe(true);
  });
  it('keeps server.json description within the registry limit', () => {
    const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
