#!/usr/bin/env node
// Builds claude-code/install.sh from the template and the files it embeds.
//   node tools/build-install.mjs          write install.sh
//   node tools/build-install.mjs --check  exit 1 if install.sh is out of date
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\n$/, '');

export function buildInstall() {
  const agent = read('claude-code/agents/repo-scout.md');
  const hook = read('claude-code/hooks/ads-guard.sh');
  for (const [name, text, end] of [
    ['agent', agent, 'SCOUT_AGENT_EOF'],
    ['hook', hook, 'SCOUT_HOOK_EOF'],
  ]) {
    if (text.split('\n').includes(end)) throw new Error(`${name} contains its heredoc delimiter ${end}`);
  }
  return read('claude-code/install.template.sh')
    .replace('@@AGENT@@', () => agent)
    .replace('@@HOOK@@', () => hook) + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(root, 'claude-code/install.sh');
  const built = buildInstall();
  if (process.argv.includes('--check')) {
    const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
    if (current !== built) {
      console.error('claude-code/install.sh is out of date: run node tools/build-install.mjs');
      process.exit(1);
    }
    console.log('claude-code/install.sh is up to date');
  } else {
    writeFileSync(out, built);
    chmodSync(out, 0o755);
    console.log('wrote claude-code/install.sh');
  }
}
