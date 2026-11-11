import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildInstall } from '../tools/build-install.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'claude-code/install.sh');

function run(dir, env = {}) {
  const r = spawnSync('sh', [script], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout + r.stderr;
}
const tmp = () => mkdtempSync(join(tmpdir(), 'scout-'));
const settings = (d) => JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
const ours = (s) => (s.hooks?.PreToolUse ?? []).filter((g) => JSON.stringify(g).includes('scout-ads-guard'));

test('committed install.sh matches its template and sources', () => {
  assert.equal(readFileSync(script, 'utf8'), buildInstall());
});

test('fresh install: advisor, agent, hook and hook entry', () => {
  const d = tmp();
  run(d);
  const s = settings(d);
  assert.equal(s.advisorModel, 'fable');
  assert.equal(ours(s).length, 1);
  assert.equal(ours(s)[0].matcher, '^mcp__');
  assert.equal(
    readFileSync(join(d, 'agents/repo-scout.md'), 'utf8'),
    readFileSync(join(root, 'claude-code/agents/repo-scout.md'), 'utf8'),
  );
  assert.equal(
    readFileSync(join(d, 'hooks/scout-ads-guard.sh'), 'utf8'),
    readFileSync(join(root, 'claude-code/hooks/ads-guard.sh'), 'utf8'),
  );
  // the installed hook runs through the command written into settings
  const cmd = ours(s)[0].hooks[0].command;
  const r = spawnSync('sh', ['-c', cmd], {
    input: JSON.stringify({ tool_name: 'mcp__Meta_Ads__delete_campaign', permission_mode: 'default' }),
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  rmSync(d, { recursive: true });
});

test('second run changes nothing and makes no backup', () => {
  const d = tmp();
  run(d);
  const out = run(d);
  assert.match(out, /already up to date/);
  assert.equal(readdirSync(d).filter((f) => f.includes('.bak-')).length, 0);
  assert.equal(ours(settings(d)).length, 1);
  rmSync(d, { recursive: true });
});

test('existing settings are kept, backed up, and an existing advisor is not overridden', () => {
  const d = tmp();
  const before = {
    model: 'opus',
    advisorModel: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
  };
  writeFileSync(join(d, 'settings.json'), JSON.stringify(before));
  const out = run(d);
  const s = settings(d);
  assert.equal(s.advisorModel, 'opus');
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, before.permissions);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.match(out, /backup saved/);
  const backups = readdirSync(d).filter((f) => f.startsWith('settings.json.bak-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(d, backups[0]), 'utf8')), before);
  rmSync(d, { recursive: true });
});

test('SCOUT_ADVISOR=off leaves the advisor unset', () => {
  const d = tmp();
  run(d, { SCOUT_ADVISOR: 'off' });
  assert.equal(settings(d).advisorModel, undefined);
  rmSync(d, { recursive: true });
});

test('dry run shows a diff and writes nothing', () => {
  const d = tmp();
  const out = run(d, { SCOUT_DRY_RUN: '1' });
  assert.match(out, /advisorModel/);
  assert.match(out, /dry run/);
  assert.equal(existsSync(join(d, 'settings.json')), false);
  assert.equal(existsSync(join(d, 'agents/repo-scout.md')), false);
  rmSync(d, { recursive: true });
});

test('invalid settings.json is left alone', () => {
  const d = tmp();
  writeFileSync(join(d, 'settings.json'), '{broken');
  const out = run(d);
  assert.match(out, /not valid JSON/);
  assert.equal(readFileSync(join(d, 'settings.json'), 'utf8'), '{broken');
  rmSync(d, { recursive: true });
});

test('uninstall removes only what scout added', () => {
  const d = tmp();
  writeFileSync(join(d, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
  }));
  run(d);
  run(d, { SCOUT_UNINSTALL: '1' });
  const s = settings(d);
  assert.equal(ours(s).length, 0);
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(existsSync(join(d, 'agents/repo-scout.md')), false);
  assert.equal(existsSync(join(d, 'hooks/scout-ads-guard.sh')), false);
  rmSync(d, { recursive: true });
});
