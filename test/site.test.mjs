import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { renderAds } from '../tools/build-site.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const TEXT = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt']);
const textFiles = () => walk(site).filter((f) => TEXT.has(extname(f)));
const pages = () => readdirSync(site).filter((f) => f.endsWith('.html'));
const read = (f) => readFileSync(f, 'utf8');
const loadJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const allText = () => textFiles().map(read).join('\n');

test('site/ is current (npm run build would change nothing)', () => {
  const r = spawnSync(process.execPath, ['tools/build-site.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('Worker config serves site/', () => {
  const w = JSON.parse(read(join(root, 'wrangler.jsonc')));
  assert.equal(w.name, 'scout');
  assert.equal(w.assets.directory, 'site');
});

test('every page links and loads only files inside site/; nothing external is loaded', () => {
  assert.ok(pages().length >= 4);
  for (const f of pages()) {
    const html = read(join(site, f));
    for (const m of html.matchAll(/<(\w+)[^>]*?\s(href|src)="([^"]*)"/g)) {
      const [, tag, , url] = m;
      if (/^https?:\/\//.test(url)) {
        assert.equal(tag, 'a', `${f}: ${url} is loaded by <${tag}>; only <a> may point outside site/`);
        continue;
      }
      assert.ok(!url.startsWith('//') && !/^[a-z]+:/i.test(url), `${f}: odd url ${url}`);
      const [pathPart, hash] = url.split('#');
      const target = pathPart ? resolve(site, pathPart) : join(site, f);
      assert.ok(target.startsWith(site + '/') || target === site, `${f}: ${url} leaves site/`);
      assert.ok(existsSync(target), `${f}: ${url} does not exist`);
      if (hash && target.endsWith('.html')) assert.match(read(target), new RegExp(`id="${hash}"`), `${f}: #${hash} missing`);
    }
    assert.doesNotMatch(html, /<script[^>]*src="https?:/);
    assert.doesNotMatch(html, /<link[^>]*href="https?:/);
    assert.doesNotMatch(html, /@import|url\(https?:/);
  }
  for (const f of walk(site).filter((x) => x.endsWith('.css'))) assert.doesNotMatch(read(f), /url\(\s*['"]?https?:|@import\s+url\(\s*['"]?https?:/);
});

test('every page carries the independence notice in both languages, word for word', () => {
  const brand = loadJson('ads/approved-facts.json').disclaimers; // the same wording as UFUQ identity/brand.json
  const en = 'Not affiliated with GACA. Always verify against the latest official GACA publication.';
  const ar = 'غير تابعة لـ GACA. تحقّق دائمًا من أحدث منشور رسمي صادر عن GACA.';
  assert.ok(brand.en.includes(en) && brand.ar.includes(ar));
  for (const f of pages()) {
    const html = read(join(site, f));
    assert.ok(html.includes(`<p lang="en" dir="ltr">${en}</p>`), f);
    assert.ok(html.includes(`<p lang="ar" dir="rtl">${ar}</p>`), f);
    assert.match(html, /<footer class="ufuq-shell-foot">/);
    assert.match(html, /class="ufuq-ar" lang="ar"/);
  }
});

test('generated data holds no value from approved-facts.json', () => {
  const facts = loadJson('ads/approved-facts.json');
  const strings = [];
  const numbers = [];
  const collect = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (typeof v === 'number') numbers.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  // The disclaimers are the approved independence notice, which every page must print; the rest is the owner's.
  for (const [k, v] of Object.entries(facts)) if (k !== 'disclaimers' && !k.startsWith('_')) collect(v);
  assert.ok(strings.length > 0);
  const text = allText();
  const domains = new Set(facts.landing_domains || []);
  for (const s of strings) {
    if (domains.has(s)) {
      const re = new RegExp(`(^|[^\\w.-])${s.replace(/\./g, '\\.')}`, 'i');
      assert.doesNotMatch(text, re, `domain ${s} appears in site/`);
    } else {
      assert.ok(!text.includes(s) && !text.includes(s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')), `value "${s}" appears in site/`);
    }
  }
  for (const n of numbers) assert.doesNotMatch(text, new RegExp(`(^|[^\\d.])${n}([^\\d]|$)`), `number ${n} appears in site/`);
  const data = loadJson('site/data.json');
  assert.deepEqual(Object.keys(data.facts), ['keys']);
  for (const k of data.facts.keys) assert.deepEqual(Object.keys(k).sort(), ['count', 'key', 'kind']);
});

test('generated data holds no copy of an ad copy file', () => {
  const dir = join(root, 'ads/copy');
  // The file's own name is shown as a source, so it is removed first; its contents must not appear.
  const names = readdirSync(dir).filter((x) => x.endsWith('.json'));
  let text = allText();
  for (const n of names) text = text.split(`ads/copy/${n}`).join('').split(n).join('');
  const strings = [];
  const collect = (v) => {
    if (typeof v === 'string') { if (v.length >= 20) strings.push(v); }
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  // The copy itself: each variant's text fields and landing url (format and id names are not copy).
  for (const f of names) for (const v of JSON.parse(readFileSync(join(dir, f), 'utf8')).variants || []) { collect(v.fields); collect(v.url); }
  // The approved disclaimers are the notice every page prints; they are not what is being kept out.
  const notice = Object.values(loadJson('ads/approved-facts.json').disclaimers).flat();
  const own = strings.filter((s) => !notice.includes(s));
  assert.ok(own.length > 0);
  for (const s of own) assert.ok(!text.includes(s), `copy text appears in site/: ${s}`);
  assert.ok(!existsSync(join(site, 'ads')));
  assert.ok(!walk(site).some((f) => /approved-facts|ads[\\/]copy/.test(relative(site, f))));
});

test('limits marked verified carry a source link (and one without is flagged)', () => {
  const rows = loadJson('site/data.json').limits.rows;
  assert.ok(rows.length > 0);
  for (const r of rows) if (r.verified) assert.ok(r.source, `${r.id} verified without a source`);
  const base = { id: 'x', platform: 'P', field: 'f', limit: 'max 1', thirdParty: false };
  const data = {
    builtOn: '2026-01-01',
    facts: { keys: [] },
    copy: [],
    limits: { note: null, rows: [
      { ...base, verified: true, source: 'https://example.org/docs' },
      { ...base, id: 'y', verified: true, source: null },
      { ...base, id: 'z', verified: false, source: null, thirdParty: true },
    ] },
  };
  const html = renderAds(data);
  assert.match(html, /<a href="https:\/\/example\.org\/docs" rel="noopener noreferrer">/);
  assert.match(html, /Marked verified, no source/);
  assert.match(html, /Third-party claim/);
});

test('scheduled-task days are computed in the browser from expiresAt, not baked in', () => {
  const text = allText();
  assert.doesNotMatch(text, /\b\d+ days? (left|ago)\b/);
  assert.doesNotMatch(text, /"daysLeft"|"daysRemaining"/);
  const html = read(join(site, 'schedule.html'));
  const tasks = loadJson('.qoder/scheduled_tasks.json');
  assert.match(html, new RegExp(`data-expires="${tasks.expiresAt}"`));
  assert.match(html, /<script src="scout\.js" defer>/);
  const ctx = { globalThis: {} };
  ctx.globalThis = ctx;
  vm.runInNewContext(read(join(site, 'scout.js')), ctx);
  const { daysLeft, describe } = ctx.ScoutDays;
  assert.equal(daysLeft('2026-11-22', new Date(2026, 10, 17, 23, 59)), 5);
  assert.equal(daysLeft('2026-11-22', new Date(2026, 10, 22, 0, 1)), 0);
  assert.equal(daysLeft('2026-11-22', new Date(2026, 10, 25)), -3);
  assert.equal(daysLeft('2026-12-01', new Date(2026, 10, 17)), 14);
  assert.equal(describe(13).tone, 'warning');
  assert.match(describe(13).stateEn, /soon/i);
  assert.equal(describe(14).tone, 'success');
  assert.equal(describe(-1).tone, 'danger');
  assert.match(describe(5).ar, /تبقى/);
});

test("the site's CSS holds no literal colour or physical property", () => {
  const css = read(join(site, 'site.css'));
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(css, /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i);
  assert.doesNotMatch(css, /:\s*(white|black|red|green|blue|gray|grey|orange|yellow|purple|teal|gold)\b/i);
  assert.doesNotMatch(css, /(^|[;{\s])(margin|padding|border)-(left|right)\s*:/);
  assert.doesNotMatch(css, /(^|[;{\s])(left|right|width|height)\s*:/);
  assert.doesNotMatch(css, /!important/);
});

test('the data records both checkers and the build date', () => {
  const data = loadJson('site/data.json');
  assert.match(data.builtOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(data.copy) && data.copy.length > 0);
  assert.ok(data.gate.checks.length === 6);
});
