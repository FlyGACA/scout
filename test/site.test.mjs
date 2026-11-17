import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { renderAds, renderLimits, renderPlan, renderGate, renderChecks, renderCopycheck, parsePlan, commandsFrom, playbookFrom, copycheckFrom } from '../tools/build-site.mjs';
import { renderMarkdown } from '../tools/lib/markdown.mjs';
import { norm, BANNED } from '../tools/ad-copy-lint.mjs';

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
  assert.ok(pages().length >= 10);
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
      // The 404 page is served for any missing path, so it names its files from the site root.
      const target = pathPart ? (pathPart.startsWith('/') ? resolve(site, '.' + pathPart) : resolve(site, pathPart)) : join(site, f);
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


/* ------------------------------------------------------------------ polish */

const NAV = ['index', 'ads', 'limits', 'playbook', 'gate', 'plan', 'schedule', 'checks', 'copycheck'];
const loadScout = () => {
  const ctx = { globalThis: {} };
  ctx.globalThis = ctx;
  vm.runInNewContext(read(join(site, 'scout.js')), ctx);
  return ctx.ScoutTools;
};

test('every page has a skip link, a focusable main, a distinct title and the nav lists every page', () => {
  const titles = new Set();
  for (const f of pages()) {
    const html = read(join(site, f));
    assert.match(html, /<a class="skip-link" href="#main">/, f);
    assert.match(html, /<main[^>]*id="main"[^>]*tabindex="-1"/, f);
    const t = /<title>([^<]*)<\/title>/.exec(html)[1];
    assert.ok(!titles.has(t), `duplicate title ${t}`);
    titles.add(t);
    assert.match(t, / — Scout$/);
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${f}: exactly one h1`);
    for (const n of NAV) assert.match(html, new RegExp(`<nav[^>]*>[^]*href="(/)?${n}\\.html"`), `${f}: nav lacks ${n}`);
    // every table scrolls by itself, can take focus and has a name
    for (const m of html.matchAll(/<div class="ufuq-table-wrap[^>]*>/g)) assert.match(m[0], /tabindex="0"[^>]*role="region"[^>]*aria-label="[^"]+"/);
    // every form control is labelled
    for (const m of html.matchAll(/<(input|select|textarea)[^>]*\sid="([^"]+)"/g)) assert.match(html, new RegExp(`<label[^>]*for="${m[2]}"|<label[^>]*>\\s*<input[^>]*id="${m[2]}"`), `${f}: #${m[2]} has no label`);
  }
  assert.deepEqual(NAV.filter((n) => !pages().includes(`${n}.html`)), []);
});

test('there is a real 404 page and the Worker serves it for unknown paths', () => {
  const w = JSON.parse(read(join(root, 'wrangler.jsonc')));
  assert.equal(w.assets.not_found_handling, '404-page');
  const html = read(join(site, '404.html'));
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /href="\/site\.css"|href="\/ufuq\/ufuq\.css"/);
  assert.match(html, /Page not found/);
  assert.match(html, /الصفحة غير موجودة/);
});

test('print styles use paper and ink tokens and hide the chrome', () => {
  const css = read(join(site, 'site.css'));
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /--ufuq-print-paper/);
  assert.match(print, /--ufuq-print-ink\b/);
  assert.match(print, /\.ufuq-shell/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.skip-link/);
});

test('scout.js makes no network call and stores nothing', () => {
  const js = read(join(site, 'scout.js'));
  assert.doesNotMatch(js, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|document\.cookie)\b/);
  assert.doesNotMatch(js, /\beval\(|new Function\(/);
});

test('the plan page shows every phase from PLAN.md and invents no status', () => {
  const plan = parsePlan(read(join(root, 'PLAN.md')));
  const html = read(join(site, 'plan.html'));
  const lines = read(join(root, 'PLAN.md')).split('\n').filter((l) => /^\| \*\*\d/.test(l));
  assert.equal(plan.phases.length, lines.length);
  assert.ok(plan.phases.length >= 5);
  for (const p of plan.phases) assert.ok(html.includes(p.phase.replace(/&/g, '&amp;')), p.phase);
  const boxes = read(join(root, 'PLAN.md')).split('\n').filter((l) => /^- \[[ xX]\]/.test(l));
  assert.equal(plan.decisions.length, boxes.length);
  assert.equal(plan.decisions.filter((d) => d.done).length, boxes.filter((l) => /^- \[[xX]\]/.test(l)).length);
  assert.match(html, new RegExp(`<progress[^>]*max="${plan.decisions.length}" value="${plan.decisions.filter((d) => d.done).length}"`));
  if (!plan.phases.some((p) => p.status)) {
    assert.doesNotMatch(html, /ufuq-badge--brand/);
    assert.equal((html.match(/Status not written in PLAN\.md/g) || []).length, plan.phases.length);
  }
  for (const p of plan.phases) for (const l of p.links) assert.ok(html.includes(`href="${l.url}"`), l.url);
});

test('a Status column in PLAN.md is read as written; links and ticks are parsed (synthetic file)', () => {
  const text = [
    '## Phases', '',
    '| Phase | Who | What | Done when | Status |', '| --- | --- | --- | --- | --- |',
    '| **0. Alpha** | A | do a [PR](https://example.org/pr/1) | seen | Done |',
    '| **1. Beta** | B | do b | seen | |', '',
    '## Owner decisions', '- [x] one', '- [ ] two', '',
  ].join('\n');
  const plan = parsePlan(text);
  assert.equal(plan.phases[0].status, 'Done');
  assert.equal(plan.phases[1].status, null);
  assert.deepEqual(plan.phases[0].links, [{ text: 'PR', url: 'https://example.org/pr/1' }]);
  assert.deepEqual(plan.decisions.map((d) => d.done), [true, false]);
  const html = renderPlan({ builtOn: '2026-01-01', plan });
  assert.match(html, /ufuq-badge--brand"><span class="ufuq-en">Done</);
  assert.match(html, /Status not written in PLAN\.md/);
  assert.match(html, /value="1"/);
  assert.match(renderPlan({ builtOn: '2026-01-01', plan: { phases: [], decisions: [], open: [] } }), /No phases found/);
});

test('the gate table lists every check and every setting from scripts/gate.config.json', () => {
  const cfg = loadJson('scripts/gate.config.json');
  const data = loadJson('site/data.json');
  const rows = data.gate.rows;
  for (const name of ['disclaimer', 'gacar', 'bilingual', 'register', 'links', 'sources']) assert.ok(rows.some((r) => r.check === name && r.kind === 'check'), name);
  for (const [check, c] of Object.entries(cfg)) {
    if (typeof c !== 'object' || Array.isArray(c)) continue;
    for (const [k, v] of Object.entries(c)) {
      const row = rows.find((r) => r.check === check && r.setting === k);
      assert.ok(row, `${check}.${k}`);
      assert.equal(row.value, Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : String(v));
      assert.equal(row.kind, k === 'include' || k === 'exclude' ? 'scope' : 'limit');
    }
  }
  const html = read(join(site, 'gate.html'));
  assert.match(html, /data-filter-for="gate-table"/);
  assert.equal((html.match(/<tr data-f-check=/g) || []).length, rows.length);
  assert.match(html, /class="empty-row" hidden/);
  // unconfigured checks stay visible and are marked off
  assert.match(html, /data-f-state="off"/);
  const synthetic = renderGate({ builtOn: '2026-01-01', gate: { errors: 0, warnings: 0, findings: [], checks: [], rows: [{ check: 'links', kind: 'limit', setting: 'maxExternal', value: '9', files: null, on: true, description: '' }] } });
  assert.match(synthetic, /data-f-kind="limit"[^>]*>.*maxExternal/s);
});

test('table filters search and narrow rows', () => {
  const { filterRows } = loadScout();
  const rows = [
    { text: 'gacar maxPart 199', attrs: { check: 'gacar', kind: 'limit' } },
    { text: 'links include **/*.md', attrs: { check: 'links', kind: 'scope' } },
    { text: 'links maxExternal 25', attrs: { check: 'links', kind: 'limit' } },
  ];
  assert.deepEqual(filterRows(rows, '', {}), [true, true, true]);
  assert.deepEqual(filterRows(rows, 'MAXP', {}), [true, false, false]);
  assert.deepEqual(filterRows(rows, '', { check: 'links' }), [false, true, true]);
  assert.deepEqual(filterRows(rows, 'max', { check: 'links', kind: 'limit' }), [false, false, true]);
  assert.deepEqual(filterRows(rows, 'nothing', {}), [false, false, false]);
});

test('the limits page shows each limit with the flag and source exactly as the file has them', () => {
  const limits = loadJson('ads/platform-limits.json');
  const html = read(join(site, 'limits.html'));
  const data = loadJson('site/data.json');
  let fields = 0;
  for (const [id, f] of Object.entries(limits)) {
    if (id.startsWith('_')) continue;
    for (const [field, rule] of Object.entries(f.fields)) {
      fields++;
      const row = data.limits.rows.find((r) => r.id === id && r.field === field);
      assert.ok(row, `${id}.${field}`);
      assert.equal(row.max, rule.max ?? null);
      assert.equal(row.recommended, rule.recommended ?? null);
      assert.equal(row.verified, f.verified === true);
      assert.equal(row.source, f.source || null);
    }
  }
  assert.equal(data.limits.rows.length, fields);
  assert.equal((html.match(/<tr data-f-platform=/g) || []).length, fields);
  assert.match(html, /data-filter-for="limits-table"/);
  // nothing is shown verified that the file does not mark verified
  const nVerified = data.limits.rows.filter((r) => r.verified).length;
  assert.equal((html.match(/data-f-status="verified"/g) || []).length, nVerified);
  const base = { id: 'x', platform: 'P', field: 'f', limit: 'max 1', max: 1, recommended: null };
  const synth = renderLimits({
    builtOn: '2026-01-01',
    limits: { note: null, rows: [
      { ...base, verified: false, verifiedRaw: 'false', source: 'https://example.org/blog', thirdParty: true },
      { ...base, id: 'y', verified: true, verifiedRaw: 'true', source: 'https://example.org/docs', thirdParty: false },
      { ...base, id: 'z', verified: false, verifiedRaw: 'null', source: null, thirdParty: false },
    ] },
  });
  assert.match(synth, /<a href="https:\/\/example\.org\/blog" rel="noopener noreferrer">/, 'a source the file names is shown even when not verified');
  assert.match(synth, /data-f-third="yes"/);
  assert.match(synth, /Third-party claim/);
  assert.match(synth, /<td class="mono ltr">null<\/td>/);
  assert.equal((synth.match(/data-f-status="verified"/g) || []).length, 1);
  assert.match(synth, /data-f-status="unverified"/);
});

test('the playbook page has a contents list whose anchors all exist, and every h2 of the file', () => {
  const md = read(join(root, 'ads/PLAYBOOK.md'));
  const html = read(join(site, 'playbook.html'));
  const h2 = [...md.matchAll(/^## (.*)$/gm)].map((m) => m[1].replace(/[`*]/g, ''));
  assert.ok(h2.length >= 6);
  const toc = [...html.matchAll(/<li><a href="#([^"]+)" lang="en">([^<]*)<\/a><\/li>/g)];
  assert.equal(toc.length, h2.length);
  for (const [, id, text] of toc) {
    assert.match(html, new RegExp(`<h2 id="${id}">`));
    assert.match(html, new RegExp(`href="#${id}" aria-label="Link to this section`));
    assert.ok(h2.some((h) => h.replace(/&/g, '&amp;') === text), text);
  }
  assert.equal(new Set(toc.map((t) => t[1])).size, toc.length);
});

test('the playbook withholds passages that name approved facts, and never links a repository file', () => {
  const facts = loadJson('ads/approved-facts.json');
  const html = read(join(site, 'playbook.html'));
  for (const d of facts.landing_domains) assert.doesNotMatch(html, new RegExp(`(^|[^\\w.-])${d.replace(/\./g, '\\.')}`, 'i'), d);
  assert.match(html, /class="withheld"/);
  assert.match(html, /Some passages are withheld/);
  const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('#') && !/^(index|ads|limits|playbook|gate|plan|schedule|checks|copycheck)\.html$/.test(u));
  for (const u of hrefs) assert.match(u, /^https?:\/\//, u);
  // the renderer itself
  const r = renderMarkdown('## A\n\nsee [f](x/y.md) and [w](https://example.org) <b>x</b>\n\n- one\n  | a | b |\n  | - | - |\n  | secret.example | 2 |\n', { withhold: (t) => t.includes('secret.example') });
  assert.match(r.html, /<code class="mono ltr">f<\/code>/);
  assert.match(r.html, /<a href="https:\/\/example\.org" rel="noopener noreferrer">w<\/a>/);
  assert.match(r.html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(r.html, /secret\.example/);
  assert.equal(r.withheld, 1);
  assert.deepEqual(r.toc.map((t) => t.id), ['a']);
  const pb = playbookFrom('# T\n\n## S\n\nGo to flygaca.com now. Fine text.\n\nOther text.', { landing_domains: ['flygaca.com'], offers: {}, disclaimers: { en: ['x'] } });
  assert.doesNotMatch(pb.html, /flygaca\.com/);
  assert.match(pb.html, /Other text\./);
});

test('the checks page lists the real commands from CLAUDE.md, each with a copy button', () => {
  const md = read(join(root, 'CLAUDE.md'));
  const pkg = loadJson('package.json');
  const cmds = commandsFrom(md, pkg.scripts);
  assert.ok(cmds.length >= 5);
  const html = read(join(site, 'checks.html'));
  const inTable = md.split('\n').filter((l) => /^\| .* \| `/.test(l) && !/^\| Task/.test(l));
  assert.equal(cmds.length, inTable.length);
  for (const c of cmds) {
    assert.ok(md.includes('`' + c.command + '`'), `${c.command} is not in CLAUDE.md`);
    const esc = c.command.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    assert.ok(html.includes(`data-copy="${esc}"`), c.command);
    assert.ok(html.includes(`<code class="cmd" dir="ltr">${esc}</code>`), c.command);
    if (c.script) assert.equal(c.scriptExists, Object.prototype.hasOwnProperty.call(pkg.scripts, c.script), c.script);
  }
  for (const needle of ['npm run check', 'npm run build', 'node tools/ad-copy-lint.mjs', 'node scripts/gate.mjs']) assert.ok(cmds.some((c) => c.command.startsWith(needle)), needle);
  assert.match(html, /This site runs nothing/);
  // a command that names a missing npm script is flagged
  const synth = commandsFrom('## Commands\n| Task | Command |\n| --- | --- |\n| Go | `npm run nope` (a note) |\n', { check: 'x' });
  assert.deepEqual([synth[0].script, synth[0].scriptExists, synth[0].note], ['nope', false, 'a note']);
  assert.match(renderChecks({ builtOn: '2026-01-01', commands: synth, requirements: '' }), /not in package\.json/);
  assert.match(renderChecks({ builtOn: '2026-01-01', commands: [], requirements: '' }), /No commands found/);
});

test('the copy self-check carries limits and claim patterns, and none of the owner\'s facts', () => {
  const html = read(join(site, 'copycheck.html'));
  const m = /<script type="application\/json" id="cc-data">([^<]*)<\/script>/.exec(html);
  assert.ok(m);
  const cfg = JSON.parse(m[1]);
  assert.deepEqual(Object.keys(cfg).sort(), ['banned', 'formats', 'free', 'marker', 'notice', 'price']);
  assert.equal(cfg.banned.length, BANNED.length);
  const limits = loadJson('ads/platform-limits.json');
  assert.equal(cfg.formats.length, Object.keys(limits).filter((k) => !k.startsWith('_')).length);
  const facts = loadJson('ads/approved-facts.json');
  const blob = JSON.stringify(cfg);
  for (const [k, v] of Object.entries(facts)) {
    if (k === 'disclaimers' || k.startsWith('_')) continue;
    const strings = [];
    const walk = (x) => (typeof x === 'string' ? strings.push(x) : Array.isArray(x) ? x.forEach(walk) : x && typeof x === 'object' ? Object.values(x).forEach(walk) : 0);
    walk(v);
    for (const str of strings) assert.ok(!blob.includes(str), `${k}: "${str}" in the self-check data`);
  }
  assert.doesNotMatch(blob, /offers|landing_domains|prices/);
  assert.ok(!existsSync(join(site, 'ads')));
  // data can not close the script element
  assert.match(renderCopycheck({ builtOn: '2026-01-01', copycheck: { ...cfg, formats: [{ id: 'a', platform: '</script><b>', verified: false, source: null, fields: [] }] } }), /\\u003c\/script\\u003e/);
});

test('the browser-side normalisation matches the checker, and the self-check finds what the checker finds', () => {
  const { norm: bnorm, checkCopy } = loadScout();
  for (const s of ['Not Affiliated  With GACA', 'مُعتمَد ـــ رَسمي', 'Ｆｕｌｌ café', ' A\nB ']) assert.equal(bnorm(s), norm(s));
  const cfg = copycheckFrom(loadJson('ads/platform-limits.json'));
  const base = { format: 'google_search_rsa', field: 'headline', lang: 'en', elsewhere: false };
  const lv = (text, o = {}) => checkCopy(cfg, { ...base, ...o, text }).map((f) => f.level + ':' + f.en);
  assert.equal(lv('').length, 0);
  assert.ok(lv('x'.repeat(31)).some((x) => /31 characters, max 30/.test(x)));
  assert.ok(!lv('x'.repeat(30)).some((x) => /characters/.test(x)));
  assert.ok(lv('Official exam course').some((x) => /"official" implies official status/.test(x)));
  assert.ok(lv('Pass guaranteed').some((x) => /guaranteed/.test(x)));
  assert.ok(lv('Approved by experts').some((x) => /approved/.test(x)));
  assert.ok(lv('دورة معتمدة', { lang: 'ar' }).some((x) => /معتمد/.test(x)));
  assert.ok(lv('Only 99 SAR').some((x) => x.startsWith('warn:looks like a price')));
  assert.ok(lv('Study for free').some((x) => x.startsWith('warn:says free')));
  assert.ok(lv('Study now').some((x) => x.startsWith('error:no "not affiliated')));
  assert.ok(lv('Study now', { elsewhere: true }).some((x) => x.startsWith('warn:no disclaimer in the text')));
  assert.ok(lv('Not affiliated with GACA. Always verify against the latest official GACA publication.').every((x) => !/official/.test(x)), 'the approved notice is not flagged');
  assert.ok(lv('غير تابعة لـ GACA', { lang: 'ar' }).every((x) => !/no "not affiliated/.test(x)));
  // limits come from the file; an unverified limit says so
  assert.ok(lv('y'.repeat(31)).some((x) => /max 30 \(limit not yet verified\)/.test(x)));
  // the recommended-only formats warn, they do not fail
  const meta = checkCopy(cfg, { format: 'meta_feed', field: 'headline', lang: 'en', elsewhere: true, text: 'z'.repeat(60) });
  assert.ok(meta.some((f) => f.level === 'warn' && /gets cut off after 40/.test(f.en)));
  assert.ok(meta.every((f) => f.level !== 'error'));
});
