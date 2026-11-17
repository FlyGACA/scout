#!/usr/bin/env node
// Builds site/ (the Scout dashboard, served by the Cloudflare Worker "scout") from the
// repository's own files. Node 20, no dependencies, no network, read-only.
//   node tools/build-site.mjs          write site/
//   node tools/build-site.mjs --check  exit 1 if site/ is out of date
//
// It runs the repository's own checkers (ads copy checker, content gate) and records what
// they report. Findings never fail the build: the site shows them. Only --check fails, and
// only when what is on disk differs from what the sources produce.
//
// Never written to site/: ads/approved-facts.json values, and the ad copy files.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { lintCampaign, BANNED, PRICE, FREE, MARKER } from './ad-copy-lint.mjs';
import { runGate, loadConfig, matchFiles, formatSarif, CHECK_NAMES } from '../scripts/gate.mjs';
import { renderMarkdown } from './lib/markdown.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'site';
const VENDORED = [
  'ufuq/ufuq.css',
  'ufuq/ufuq.components.css',
  'ufuq/ufuq.shell.js',
  'ufuq/scout-mark.svg',
  'ufuq/scout-mark-ink.svg',
  'ufuq/flygaca-mark.png',
  'ufuq/SOURCE.txt',
];
const GENERATED_FROM_TOOLS = { 'site.css': 'tools/site/site.css', 'scout.js': 'tools/site/scout.js' };

// The approved independence notice: disclaimer.en and disclaimer.ar in FlyGACA/UFUQ identity/brand.json.
const NOTICE_EN = 'Not affiliated with GACA. Always verify against the latest official GACA publication.';
const NOTICE_AR = 'غير تابعة لـ GACA. تحقّق دائمًا من أحدث منشور رسمي صادر عن GACA.';

const SIBLINGS = [
  ['https://airspace.flygaca.com/', 'Airspace', 'المجال الجوي'],
  ['https://c172.flygaca.com/', 'C172 Twin', 'توأم سيسنا 172'],
  ['https://office.flygaca.com/', 'Office', 'المكتب'],
  ['https://prompt.flygaca.com/', 'Prompt Library', 'مكتبة الأوامر'],
  ['https://skill.flygaca.com/', 'Skills', 'المهارات'],
];
const FAMILY_HOME = 'https://office.flygaca.com/';

const loadJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const exists = (p) => existsSync(join(root, p));

/* ------------------------------------------------------------------ data */

function plainMd(s) {
  return String(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const rawLinks = (cell) =>
  [...String(cell).matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => ({ text: m[1], url: m[2] }));

// Reads PLAN.md: the phases table (columns found by their header, so a Status column is read
// if the owner adds one), the owner decisions (checkboxes) and the open items.
export function parsePlan(text) {
  const lines = text.split(/\r?\n/);
  const phases = [];
  const decisions = [];
  const open = [];
  let section = '';
  let cols = null;
  for (const line of lines) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      section = h[1].trim();
      cols = null;
      continue;
    }
    if (section === 'Phases' && /^\|/.test(line)) {
      const raw = line.split(/(?<!\\)\|/).slice(1, -1);
      const cells = raw.map((c) => plainMd(c));
      if (!cols) {
        cols = cells.map((c) => c.toLowerCase());
        continue;
      }
      if (/^\|\s*:?-{3,}/.test(line) || !/^\|\s*\*\*\d/.test(line) || cells.length < 4) continue;
      const at = (name, fallback) => {
        const i = cols.indexOf(name);
        return i >= 0 ? cells[i] : cells[fallback];
      };
      const si = cols.indexOf('status');
      phases.push({
        phase: at('phase', 0),
        who: at('who', 1),
        what: at('what', 2),
        doneWhen: at('done when', 3),
        status: si >= 0 && cells[si] ? cells[si] : null,
        links: raw.flatMap(rawLinks),
      });
    }
    const box = /^- \[( |x|X)\]\s+(.*)$/.exec(line);
    if (section === 'Owner decisions' && box) decisions.push({ done: box[1] !== ' ', text: plainMd(box[2]) });
    if (section === 'Open items' && /^- /.test(line)) open.push(plainMd(line.slice(2)));
  }
  return { phases, decisions, open };
}

function factsStatus(facts) {
  const keys = Object.entries(facts)
    .filter(([k]) => !k.startsWith('_'))
    .map(([key, v]) => {
      if (Array.isArray(v)) return { key, kind: 'list', count: v.length };
      if (v && typeof v === 'object') return { key, kind: 'object', count: Object.keys(v).length };
      return { key, kind: 'value', count: 1 };
    });
  return { keys };
}

function limitsRows(limits) {
  const rows = [];
  for (const [id, f] of Object.entries(limits)) {
    if (id.startsWith('_')) continue;
    const verified = f.verified === true;
    for (const [field, rule] of Object.entries(f.fields || {})) {
      const parts = [];
      if (rule.max != null) parts.push(`max ${rule.max}`);
      if (rule.recommended != null) parts.push(`recommended ${rule.recommended}`);
      rows.push({
        id,
        platform: f.platform || id,
        field,
        limit: parts.join(', ') || 'not found',
        max: rule.max ?? null,
        recommended: rule.recommended ?? null,
        verified,
        verifiedRaw: JSON.stringify(f.verified === undefined ? null : f.verified),
        source: typeof f.source === 'string' && f.source ? f.source : null,
        thirdParty: f.third_party === true,
      });
    }
  }
  return rows;
}

async function gateStatus() {
  const config = loadConfig(root);
  const checks = CHECK_NAMES.map((name) => {
    if (!config[name]) return { name, on: false, files: 0, settings: '' };
    const { include, exclude, ...rest } = config[name];
    const files = Array.isArray(include) ? matchFiles(root, include, exclude || []).length : 0;
    return { name, on: true, files, settings: JSON.stringify(rest) === '{}' ? '' : JSON.stringify(rest) };
  });
  const result = await runGate({ root, config });
  const described = Object.fromEntries(
    JSON.parse(formatSarif(result)).runs[0].tool.driver.rules.map((r) => [r.id, r.shortDescription.text]),
  );
  const rows = [];
  for (const name of CHECK_NAMES) {
    const c = checks.find((x) => x.name === name);
    const cfg = config[name];
    rows.push({ check: name, kind: 'check', setting: '', value: c.on ? 'on' : 'not configured', files: c.files, on: c.on, description: described[name] || '' });
    if (!cfg) continue;
    for (const [key, v] of Object.entries(cfg)) {
      const shown = Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : String(v);
      rows.push({ check: name, kind: key === 'include' || key === 'exclude' ? 'scope' : 'limit', setting: key, value: shown, files: null, on: true, description: '' });
    }
  }
  return {
    rows,
    checks,
    errors: result.errors.length,
    warnings: result.warnings.length,
    findings: result.findings.map((f) => ({ severity: f.severity, check: f.check, file: f.file || null, line: f.line ?? null, message: f.message })),
  };
}

export async function collect(builtOn) {
  const facts = loadJson('ads/approved-facts.json');
  const limits = loadJson('ads/platform-limits.json');
  const copyDir = join(root, 'ads/copy');
  const copy = readdirSync(copyDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const findings = lintCampaign(JSON.parse(readFileSync(join(copyDir, f), 'utf8')), { facts, limits, file: f });
      const lines = findings.map((x) => `${x.level.padEnd(5)} ${x.where}  ${x.msg}`);
      return {
        file: `ads/copy/${f}`,
        errors: findings.filter((x) => x.level === 'error').length,
        warnings: findings.filter((x) => x.level === 'warn').length,
        lines: lines.length ? lines : [`ok    ${f}`],
      };
    });
  const tasks = loadJson('.qoder/scheduled_tasks.json');
  const plan = parsePlan(readFileSync(join(root, 'PLAN.md'), 'utf8'));
  return {
    builtOn,
    sources: ['ads/approved-facts.json', 'ads/platform-limits.json', 'ads/copy/', 'ads/PLAYBOOK.md', 'scripts/gate.config.json', 'scripts/gate.mjs', '.qoder/scheduled_tasks.json', 'PLAN.md', 'CLAUDE.md', 'package.json'],
    facts: factsStatus(facts),
    limits: { note: typeof limits._read_me === 'string' ? limits._read_me : null, rows: limitsRows(limits) },
    copy,
    gate: await gateStatus(),
    tasks: {
      generatedAt: tasks.generatedAt || null,
      expiresAt: tasks.expiresAt || null,
      regenerateWith: tasks.regenerateWith || 'node scripts/regenerate-scheduled-tasks.mjs',
      notes: tasks.notes || null,
      list: (tasks.tasks || []).map((t) => ({
        id: t.id,
        title: t.title,
        schedule: t.schedule,
        promptFile: t.promptFile,
        permissionMode: t.permissionMode,
        maxTurns: t.maxTurns,
        expiresAt: t.expiresAt || tasks.expiresAt || null,
      })),
    },
    plan,
    requirements: plainMd((/^No dependencies\..*$/m.exec(readFileSync(join(root, 'CLAUDE.md'), 'utf8')) || [''])[0]),
    commands: commandsFrom(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), loadJson('package.json').scripts || {}),
    playbook: playbookFrom(readFileSync(join(root, 'ads/PLAYBOOK.md'), 'utf8'), facts),
    copycheck: copycheckFrom(limits),
  };
}

// The Commands table of CLAUDE.md: the first code span in the second column is the command.
export function commandsFrom(text, scripts) {
  const out = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { section = h[1].trim(); continue; }
    if (section !== 'Commands' || !/^\|/.test(line) || /^\|\s*-{3}/.test(line)) continue;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    const m = cells.length >= 2 && /`([^`]+)`/.exec(cells[1]);
    if (!m || cells[0] === 'Task') continue;
    const command = m[1];
    const npm = /^npm (?:run )?([\w:-]+)/.exec(command);
    out.push({
      task: plainMd(cells[0]),
      command,
      note: plainMd(cells[1].replace(m[0], '')).replace(/^\(|\)$/g, '').trim(),
      script: npm ? npm[1] : null,
      scriptExists: npm ? Object.prototype.hasOwnProperty.call(scripts, npm[1]) : null,
    });
  }
  return out;
}

// Playbook text for the site. A passage that contains any value from approved-facts.json
// (a domain, an offer's wording) is withheld: those are the owner's, and never go into site/.
export function playbookFrom(md, facts) {
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const [k, v] of Object.entries(facts)) if (k !== 'disclaimers' && !k.startsWith('_')) walk(v);
  const domains = new Set(facts.landing_domains || []);
  const hits = (text) =>
    strings.some((x) =>
      domains.has(x) ? new RegExp(`(^|[^\\w.-])${x.replace(/\./g, '\\.')}`, 'i').test(text) : x.length > 2 && text.includes(x),
    );
  const body = md.replace(/^#\s+.*\r?\n/, '');
  const r = renderMarkdown(body, {
    withhold: hits,
    placeholder: '<span class="withheld"><span class="ufuq-en">Withheld: this passage names one of the owner\'s approved facts.</span><span class="ufuq-ar" lang="ar">محجوب: يذكر هذا المقطع إحدى الحقائق التي اعتمدها المالك.</span></span>',
    tableLabel: (head) => `Table: ${head.join(', ')}`,
  });
  return { html: r.html, toc: r.toc.filter((t) => t.level === 2), withheld: r.withheld };
}

// What the browser-side copy check needs: limits and claim patterns, no approved values.
export function copycheckFrom(limits) {
  const formats = Object.entries(limits)
    .filter(([id]) => !id.startsWith('_'))
    .map(([id, f]) => ({
      id,
      platform: f.platform || id,
      verified: f.verified === true,
      source: typeof f.source === 'string' && f.source ? f.source : null,
      fields: Object.entries(f.fields || {}).map(([field, r]) => ({ field, max: r.max ?? null, recommended: r.recommended ?? null })),
    }));
  return {
    formats,
    banned: BANNED.map(([re, why]) => ({ source: re.source, flags: re.flags, why })),
    price: { source: PRICE.source, flags: PRICE.flags },
    free: { source: FREE.source, flags: FREE.flags },
    marker: { en: MARKER.en.source, ar: MARKER.ar.source },
    notice: { en: NOTICE_EN, ar: NOTICE_AR },
  };
}

/* ------------------------------------------------------------------ html */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const bi = (en, ar) => `<span class="ufuq-en">${en}</span><span class="ufuq-ar" lang="ar">${ar}</span>`;
const ltrDate = (d) => `<bdi dir="ltr">${esc(d)}</bdi>`;
const code = (s) => `<code class="mono ltr">${esc(s)}</code>`;
const srcLine = (...files) =>
  `<p class="src">${bi('Read from', 'مقروء من')} ${files.map((f) => code(f)).join(' ')}</p>`;
const badge = (tone, en, ar) => `<span class="ufuq-badge ufuq-badge--${tone}">${bi(en, ar)}</span>`;
const th = (en, ar, cls = '') => `<th scope="col"${cls ? ` class="${cls}"` : ''}>${bi(en, ar)}</th>`;
const tableWrap = (labelEn, labelAr, inner, id = '') =>
  `<div class="ufuq-table-wrap table-wrap" tabindex="0" role="region" aria-label="${esc(labelEn)}" data-label-en="${esc(labelEn)}" data-label-ar="${esc(labelAr)}"><table class="ufuq-table"${id ? ` id="${id}"` : ''}>${inner}</table></div>
  <p class="scroll-hint">${bi('Scroll the table sideways to see every column.', 'مرّر الجدول جانبيًا لرؤية كل الأعمدة.')}</p>`;
const emptyRow = (cols) =>
  `<tr class="empty-row" hidden><td colspan="${cols}">${bi('No rows match. Clear the search or a filter.', 'لا صفوف مطابقة. امسح البحث أو أحد المرشحات.')}</td></tr>`;
// A search box and selects that filter the rows of one table. Hidden until scout.js runs,
// so without JavaScript every row stays visible.
function filterBar(id, selects) {
  const sel = selects
    .map(
      ([key, en, ar, options]) =>
        `<div class="ufuq-field"><label class="ufuq-field__label" for="${id}-${key}">${bi(en, ar)}</label><select class="ufuq-select" id="${id}-${key}" data-filter-key="${key}"><option value="">${bi('All', 'الكل')}</option>${options.map(([v, oen, oar]) => `<option value="${esc(v)}">${esc(oen)} · ${esc(oar)}</option>`).join('')}</select></div>`,
    )
    .join('');
  return `<div class="filters" role="search" data-filter-for="${id}" hidden>
  <div class="ufuq-field"><label class="ufuq-field__label" for="${id}-q">${bi('Search', 'بحث')}</label><input class="ufuq-input" id="${id}-q" type="search" data-filter-q autocomplete="off"></div>
  ${sel}
  <p class="filter-count" role="status" aria-live="polite" data-filter-count></p>
</div>`;
}
const copyBtn = (text) =>
  `<button type="button" class="ufuq-btn ufuq-btn--secondary copy-btn" data-copy="${esc(text)}" hidden>${bi('Copy', 'نسخ')}<span class="ufuq-sr-only">: ${esc(text)}</span></button>`;
const out = (lines) => `<div class="out" dir="ltr" lang="en">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`;

const PAGES = [
  ['index.html', 'Overview', 'نظرة عامة', 'The state of every guardrail at a glance.', 'حالة كل حاجز أمان بنظرة واحدة.'],
  ['ads.html', 'Ads', 'الإعلانات', 'Approved facts (status only), platform limits and the copy checker result per file.', 'الحقائق المعتمدة (الحالة فقط) وحدود المنصات ونتيجة فاحص النص لكل ملف.'],
  ['limits.html', 'Limits', 'الحدود', 'Every platform text limit with its verified flag and source, searchable.', 'كل حد لنصوص المنصات مع علامة التوثيق والمصدر، مع بحث.'],
  ['playbook.html', 'Playbook', 'دليل الإعلانات', 'The ads playbook with a table of contents and anchor links.', 'دليل الإعلانات مع فهرس وروابط للأقسام.'],
  ['gate.html', 'Content gate', 'بوابة المحتوى', 'The gate\'s checks, limits and findings, searchable and filterable.', 'فحوص البوابة وحدودها ونتائجها، مع بحث وترشيح.'],
  ['plan.html', 'Plan', 'الخطة', 'The phases of PLAN.md, the owner decisions and the open items.', 'مراحل PLAN.md وقرارات المالك والبنود المفتوحة.'],
  ['schedule.html', 'Schedule', 'الجدولة', 'The Qoder scheduled tasks and the days left on each.', 'مهام Qoder المجدولة والأيام المتبقية لكل منها.'],
  ['checks.html', 'Run the checks', 'تشغيل الفحوص', 'The real commands from CLAUDE.md, each with a copy button.', 'الأوامر الفعلية من CLAUDE.md مع زر نسخ لكل أمر.'],
  ['copycheck.html', 'Copy self-check', 'فحص النص ذاتيًا', 'Check ad text against the length limits and banned-claim patterns, in your browser.', 'افحص نص الإعلان وفق حدود الطول وأنماط الادعاءات الممنوعة داخل متصفحك.'],
];

function shell(file, titleEn, titleAr, descEn, main, data) {
  const p = file === '404.html' ? '/' : '';
  const nav = PAGES.map(
    ([f, en, ar]) => `<a href="${p}${f}"${f === file ? ' aria-current="page"' : ''}>${bi(en, ar)}</a>`,
  ).join('');
  const sibs = SIBLINGS.map(([href, en, ar]) => `<li><a href="${href}">${bi(en, ar)}</a></li>`).join('\n    ');
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titleEn)} · ${esc(titleAr)} — Scout</title>
<meta name="description" content="${esc(descEn)}">${file === '404.html' ? '\n<meta name="robots" content="noindex">' : ''}
<link rel="icon" href="${p}ufuq/scout-mark.svg">
<link rel="stylesheet" href="${p}ufuq/ufuq.css">
<link rel="stylesheet" href="${p}ufuq/ufuq.components.css">
<link rel="stylesheet" href="${p}site.css">
<script src="${p}ufuq/ufuq.shell.js"></script>
<script src="${p}scout.js" defer></script>
</head>
<body class="page" data-page="${esc(file.replace('.html', ''))}">
<a class="skip-link" href="#main"><span class="ufuq-en">Skip to content</span><span class="ufuq-ar" lang="ar">انتقل إلى المحتوى</span></a>
<header class="ufuq-shell">
  <a class="ufuq-shell__brand" href="${p}index.html"><img class="on-night" src="${p}ufuq/scout-mark.svg" alt="" width="32" height="32"><img class="on-day" src="${p}ufuq/scout-mark-ink.svg" alt="" width="32" height="32"><span class="ufuq-en">Scout</span><span class="ufuq-ar" lang="ar">الكشّاف</span></a>
  <nav class="ufuq-shell__nav" aria-label="Pages" data-label-en="Pages" data-label-ar="الصفحات">${nav}</nav>
  <div class="ufuq-shell__tools">
    <span class="ufuq-shell__who" data-shell-who hidden></span>
    <a class="ufuq-shell__tool" data-shell-out hidden><span class="ufuq-en">Sign out</span><span class="ufuq-ar" lang="ar">خروج</span></a>
    <button type="button" class="ufuq-shell__tool" data-shell-theme aria-pressed="false"><span class="ufuq-en">Day / Night</span><span class="ufuq-ar" lang="ar">نهاري / ليلي</span></button>
    <button type="button" class="ufuq-shell__tool" data-shell-lang><span class="ufuq-en" lang="ar">العربية</span><span class="ufuq-ar" lang="en">English</span></button>
  </div>
</header>
<main class="ufuq-container wrap" id="main" tabindex="-1">
${main}
</main>
<footer class="ufuq-shell-foot">
  <a class="ufuq-shell-foot__family" href="${FAMILY_HOME}"><img src="${p}ufuq/flygaca-mark.png" alt="" width="48" height="48"><span class="ufuq-en">Part of Fly GACA</span><span class="ufuq-ar" lang="ar">جزء من فلاي قاكا</span></a>
  <ul class="ufuq-shell-foot__links">
    ${sibs}
  </ul>
  <p><span class="ufuq-en">Read-only. This site changes no ad account and makes no network call. Built ${ltrDate(data.builtOn)}.</span><span class="ufuq-ar" lang="ar">للقراءة فقط. لا يغيّر هذا الموقع أي حساب إعلاني ولا يجري أي اتصال بالشبكة. بُني بتاريخ ${ltrDate(data.builtOn)}.</span></p>
  <p lang="en" dir="ltr">${NOTICE_EN}</p>
  <p lang="ar" dir="rtl">${NOTICE_AR}</p>
</footer>
</body>
</html>
`;
}

function builtLine(data) {
  return `<p class="ufuq-label built"><span class="ufuq-en">Checker results captured ${ltrDate(data.builtOn)}</span><span class="ufuq-ar" lang="ar">نتائج الفحص التُقطت بتاريخ ${ltrDate(data.builtOn)}</span></p>`;
}

const soonest = (data) =>
  data.tasks.list.map((t) => t.expiresAt).filter(Boolean).sort()[0] || data.tasks.expiresAt || null;

function expiresBlock(date) {
  if (!date) return `<span class="big">${bi('not found', 'غير موجود')}</span>`;
  return `<span class="big" data-expires="${esc(date)}">${bi(`expires ${ltrDate(date)}`, `تنتهي في ${ltrDate(date)}`)}</span>`;
}

export function renderOverview(data) {
  const lim = data.limits.rows;
  const verified = lim.filter((r) => r.verified).length;
  const copyPass = data.copy.filter((c) => c.errors === 0).length;
  const copyWarn = data.copy.reduce((n, c) => n + c.warnings, 0);
  const open = data.plan.decisions.filter((d) => !d.done).length;
  const soon = soonest(data);
  const gateTone = data.gate.errors ? 'danger' : data.gate.warnings ? 'warning' : 'success';
  const gateWordsEn = data.gate.errors ? 'Has errors' : data.gate.warnings ? 'Has warnings' : 'No findings';
  const gateWordsAr = data.gate.errors ? 'فيها أخطاء' : data.gate.warnings ? 'فيها تحذيرات' : 'لا نتائج';
  return `<section class="hero" aria-labelledby="t">
  <img class="hero-mark on-night" src="ufuq/scout-mark.svg" alt="" width="120" height="120"><img class="hero-mark on-day" src="ufuq/scout-mark-ink.svg" alt="" width="120" height="120">
  <div>
    <p class="ufuq-eyebrow"><span class="ufuq-en">Fly GACA Scout</span><span class="ufuq-ar" lang="ar">الكشّاف من فلاي قاكا</span></p>
    <h1 id="t"><span class="ufuq-en">The guardrails, at a glance</span><span class="ufuq-ar" lang="ar">حواجز الأمان بنظرة واحدة</span></h1>
    <p class="lead"><span class="ufuq-en">The state of the rules that protect Fly GACA's ads and content: the owner's approved facts, the platform text limits, the ad copy checks, the content gate and the Qoder scheduled tasks.</span><span class="ufuq-ar" lang="ar">حالة القواعد التي تحمي إعلانات فلاي قاكا ومحتواها: الحقائق التي اعتمدها المالك وحدود نصوص المنصات وفحوص نص الإعلان وبوابة المحتوى ومهام Qoder المجدولة.</span></p>
    ${builtLine(data)}
    <div class="ufuq-callout ufuq-callout--caution callout-wrap"><p class="ufuq-callout__title"><span class="ufuq-en">Read-only</span><span class="ufuq-ar" lang="ar">للقراءة فقط</span></p><p><span class="ufuq-en">This page connects to no ad account, publishes nothing and makes no network call. Each number names the file it was read from. Only the browser works out the days left on the scheduled tasks.</span><span class="ufuq-ar" lang="ar">لا تتصل هذه الصفحة بأي حساب إعلاني ولا تنشر شيئًا ولا تجري أي اتصال بالشبكة. كل رقم يسمّي الملف الذي قُرئ منه. المتصفح وحده يحسب الأيام المتبقية للمهام المجدولة.</span></p></div>
  </div>
</section>
<section aria-labelledby="s">
  <h2 id="s"><span class="ufuq-en">State</span><span class="ufuq-ar" lang="ar">الحالة</span></h2>
  <dl class="stats">
    <div><dt>${bi('Approved facts (owner)', 'الحقائق المعتمدة (المالك)')}</dt><dd><span class="big ufuq-num">${data.facts.keys.length}</span> <span class="more">${bi('top-level keys; values are not shown', 'مفاتيح رئيسية؛ القيم غير معروضة')}</span></dd><dd class="src"><a href="ads.html#facts">${bi('Details', 'التفاصيل')}</a> · ${code('ads/approved-facts.json')}</dd></div>
    <div><dt>${bi('Platform limits verified', 'حدود المنصات الموثّقة')}</dt><dd><span class="big ufuq-num">${verified} / ${lim.length}</span> <span class="more">${bi('fields', 'حقلًا')}</span></dd><dd class="src"><a href="limits.html">${bi('Details', 'التفاصيل')}</a> · ${code('ads/platform-limits.json')}</dd></div>
    <div><dt>${bi('Ad copy files without errors', 'ملفات نص الإعلان بلا أخطاء')}</dt><dd><span class="big ufuq-num">${copyPass} / ${data.copy.length}</span> <span class="more">${bi(`${copyWarn} warning(s)`, `${copyWarn} تحذيرات`)}</span></dd><dd class="src"><a href="ads.html#copy">${bi('Details', 'التفاصيل')}</a> · ${code('ads/copy/')}</dd></div>
    <div><dt>${bi('Content gate', 'بوابة المحتوى')}</dt><dd>${badge(gateTone, gateWordsEn, gateWordsAr)} <span class="more ufuq-num">${data.gate.errors} / ${data.gate.warnings}</span> <span class="more">${bi('errors / warnings', 'أخطاء / تحذيرات')}</span></dd><dd class="src"><a href="gate.html">${bi('Details', 'التفاصيل')}</a> · ${code('scripts/gate.mjs')}</dd></div>
    <div><dt>${bi('Soonest Qoder task expiry', 'أقرب انتهاء لمهام Qoder')}</dt><dd>${expiresBlock(soon)} <span data-expires-badge="${esc(soon || '')}" class="ufuq-badge ufuq-badge--neutral">${bi('Check the date', 'تحقق من التاريخ')}</span></dd><dd class="src"><a href="schedule.html">${bi('Details', 'التفاصيل')}</a> · ${code('.qoder/scheduled_tasks.json')}</dd></div>
    <div><dt>${bi('Owner decisions still open', 'قرارات المالك المفتوحة')}</dt><dd><span class="big ufuq-num">${open} / ${data.plan.decisions.length}</span></dd><dd class="src"><a href="plan.html">${bi('Details', 'التفاصيل')}</a> · ${code('PLAN.md')}</dd></div>
  </dl>
</section>
<section aria-labelledby="p">
  <h2 id="p"><span class="ufuq-en">Pages</span><span class="ufuq-ar" lang="ar">الصفحات</span></h2>
  <div class="cards">
    ${PAGES.slice(1).map(([f, en, ar, den, dar]) => `<article class="ufuq-card ufuq-card--interactive"><h3 class="ufuq-card__title">${bi(en, ar)}</h3><p class="ufuq-card__body">${bi(den, dar)}</p><div class="ufuq-card__actions"><a class="ufuq-btn ufuq-btn--secondary" href="${f}">${bi('Open', 'افتح')}<span class="ufuq-sr-only">: ${esc(en)}</span></a></div></article>`).join('\n    ')}
  </div>
</section>`;
}

const limitStatus = (r) => (r.verified ? (r.source ? 'verified' : 'nosource') : 'unverified');
const sourceCell = (src) =>
  !src ? bi('none', 'لا يوجد') : /^https?:\/\//i.test(src) ? `<a href="${esc(src)}" rel="noopener noreferrer">${esc(src)}</a>` : esc(src);

// One row per platform and field, with the verified flag and source exactly as the file has them.
function limitsTable(rows, id = '') {
  const body = rows
    .map((r) => {
      const st = limitStatus(r);
      const status =
        st === 'verified'
          ? badge('success', 'Verified', 'موثّق')
          : st === 'nosource'
            ? badge('danger', 'Marked verified, no source', 'موسوم موثّقًا بلا مصدر')
            : badge('warning', 'Not verified', 'غير موثّق');
      const third = r.thirdParty ? ` ${badge('caution', 'Third-party claim', 'ادعاء من طرف ثالث')}` : '';
      return `<tr data-f-platform="${esc(r.id)}" data-f-status="${st}" data-f-third="${r.thirdParty ? 'yes' : 'no'}"><td class="ltr">${esc(r.platform)}</td><td class="mono ltr">${esc(r.field)}</td><td class="mono ltr">${esc(r.limit)}</td><td class="mono ltr">${esc(r.verifiedRaw ?? String(r.verified))}</td><td>${status}${third}</td><td class="ltr">${sourceCell(r.source)}</td></tr>`;
    })
    .join('\n');
  return tableWrap('Platform limits', 'حدود المنصات', `<thead><tr>${th('Platform', 'المنصة')}${th('Field', 'الحقل')}${th('Limit (characters)', 'الحد (بالأحرف)')}${th('verified in the file', 'verified في الملف')}${th('Status', 'الحالة')}${th('Source', 'المصدر')}</tr></thead><tbody>
${body}
${emptyRow(6)}
</tbody>`, id);
}

export function renderAds(data) {
  const factRows = data.facts.keys
    .map((k) => `<li>${esc(k.key)} · ${esc(k.kind)} · ${k.count}</li>`)
    .join('');
  const copy = data.copy
    .map((c) => {
      const tone = c.errors ? 'danger' : c.warnings ? 'warning' : 'success';
      const wEn = c.errors ? `${c.errors} error(s)` : c.warnings ? 'Passes with warnings' : 'Passes';
      const wAr = c.errors ? `${c.errors} أخطاء` : c.warnings ? 'يجتاز مع تحذيرات' : 'يجتاز';
      return `<h3>${code(c.file)} ${badge(tone, wEn, wAr)}</h3>\n${out(c.lines)}`;
    })
    .join('\n');
  return `<section aria-labelledby="t">
  <p class="ufuq-eyebrow"><span class="ufuq-en">Ads guardrails</span><span class="ufuq-ar" lang="ar">حواجز الإعلانات</span></p>
  <h1 id="t"><span class="ufuq-en">Facts, limits and copy status</span><span class="ufuq-ar" lang="ar">الحقائق والحدود وحالة النص</span></h1>
  ${builtLine(data)}
</section>
<section id="facts" aria-labelledby="f">
  <h2 id="f"><span class="ufuq-en">Approved facts</span><span class="ufuq-ar" lang="ar">الحقائق المعتمدة</span></h2>
  <div class="ufuq-callout ufuq-callout--important callout-wrap"><p class="ufuq-callout__title"><span class="ufuq-en">The values are deliberately not shown</span><span class="ufuq-ar" lang="ar">القيم غير معروضة عمدًا</span></p><p><span class="ufuq-en">The file holds the owner's prices, offers and domains. Only the owner changes it, and this site shows its shape only: which keys exist and how many entries each holds. The owner may decide later to show more.</span><span class="ufuq-ar" lang="ar">يحوي الملف أسعار المالك وعروضه ونطاقاته. المالك وحده يغيّره، ويعرض هذا الموقع شكله فقط: المفاتيح الموجودة وعدد المدخلات في كل منها. وللمالك أن يقرر لاحقًا عرض المزيد.</span></p></div>
  <p>${bi(`${data.facts.keys.length} top-level keys (name · kind · entries):`, `${data.facts.keys.length} مفاتيح رئيسية (الاسم · النوع · عدد المدخلات):`)}</p>
  <ul class="keys">${factRows}</ul>
  ${srcLine('ads/approved-facts.json')}
</section>
<section id="limits" aria-labelledby="l">
  <h2 id="l"><span class="ufuq-en">Platform limits</span><span class="ufuq-ar" lang="ar">حدود المنصات</span></h2>
  <p class="panel-note"><span class="ufuq-en">One row per platform and field. A limit counts as verified only when the file says so and names the platform's own documentation as its source. Anything else is shown as not verified; a claim taken from a third-party guide is labelled as third-party.</span><span class="ufuq-ar" lang="ar">صف لكل منصة وحقل. لا يُعدّ الحد موثّقًا إلا إذا نصّ الملف على ذلك وسمّى وثائق المنصة نفسها مصدرًا. وما سوى ذلك يظهر غير موثّق، وما أُخذ من دليل طرف ثالث يُوسم بأنه من طرف ثالث.</span></p>
  ${limitsTable(data.limits.rows)}
  <p>${bi('Search and filter every limit on', 'ابحث في كل الحدود ورشّحها في صفحة')} <a href="limits.html">${bi('the Limits page', 'الحدود')}</a>.</p>
  ${data.limits.note ? `<p class="src">${bi('The file says:', 'يقول الملف:')}</p>${out([data.limits.note])}` : ''}
  ${srcLine('ads/platform-limits.json')}
</section>
<section id="copy" aria-labelledby="c">
  <h2 id="c"><span class="ufuq-en">Ad copy status</span><span class="ufuq-ar" lang="ar">حالة نص الإعلان</span></h2>
  <p class="panel-note"><span class="ufuq-en">The copy checker ran on each file when this site was built. Its output is shown as the tool printed it. A warning does not fail the checker; a person still reviews every file.</span><span class="ufuq-ar" lang="ar">شغّل فاحص النص على كل ملف عند بناء هذا الموقع، وتظهر مخرجاته كما طبعتها الأداة. لا يُفشل التحذير الفاحص، ويراجع شخص كل ملف في النهاية.</span></p>
  ${copy}
  ${srcLine('ads/copy/', 'tools/ad-copy-lint.mjs')}
</section>`;
}

const KIND = { check: ['Check', 'فحص'], limit: ['Limit', 'حد'], scope: ['Scope', 'نطاق'] };

export function renderGate(data) {
  const g = data.gate;
  const count = (name) => g.findings.filter((f) => f.check === name).length;
  const rows = g.rows
    .map((r) => {
      const [ken, kar] = KIND[r.kind];
      const first = r.kind === 'check';
      const value = first ? (r.on ? badge('success', 'On', 'مفعّل') : badge('neutral', 'Not configured', 'غير مضبوط')) : esc(r.value);
      return `<tr data-f-check="${esc(r.check)}" data-f-kind="${r.kind}" data-f-state="${r.on ? 'on' : 'off'}"><td class="mono ltr">${first ? `<strong>${esc(r.check)}</strong>` : esc(r.check)}${first && r.description ? `<br><span class="cell-note">${esc(r.description)}</span>` : ''}</td><td>${bi(ken, kar)}</td><td class="mono ltr">${esc(r.setting || '–')}</td><td class="${first ? '' : 'mono ltr'}">${value}</td><td class="ufuq-table__num">${first && r.on ? r.files : '–'}</td><td class="ufuq-table__num">${first ? count(r.check) : '–'}</td></tr>`;
    })
    .join('\n');
  const filters = filterBar('gate-table', [
    ['check', 'Check', 'الفحص', CHECK_NAMES.map((n) => [n, n, n])],
    ['kind', 'Kind', 'النوع', Object.entries(KIND).map(([v, [en, ar]]) => [v, en, ar])],
    ['state', 'State', 'الحالة', [['on', 'On', 'مفعّل'], ['off', 'Not configured', 'غير مضبوط']]],
  ]);
  const byFile = new Map();
  for (const f of g.findings) {
    const key = `${f.check} · ${f.file || '(no file)'}`;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(`${f.severity.padEnd(7)} ${f.file || ''}${f.line != null ? ':' + f.line : ''}  [${f.check}] ${f.message}`);
  }
  const findings = g.findings.length
    ? [...byFile].map(([key, lines]) => `<h3>${code(key)}</h3>\n${out(lines)}`).join('\n')
    : `<p>${badge('success', 'No findings', 'لا نتائج')} <span class="ufuq-en">The gate reported 0 errors and 0 warnings.</span><span class="ufuq-ar" lang="ar">لم تُبلغ البوابة عن أي أخطاء أو تحذيرات.</span></p>`;
  return `<section aria-labelledby="t">
  <p class="ufuq-eyebrow"><span class="ufuq-en">Content gate</span><span class="ufuq-ar" lang="ar">بوابة المحتوى</span></p>
  <h1 id="t"><span class="ufuq-en">What the gate checks and finds</span><span class="ufuq-ar" lang="ar">ما تفحصه البوابة وما تجده</span></h1>
  <p class="lead"><span class="ufuq-en">The gate checks this repository's Markdown against Fly GACA's content policies. It ran when this site was built.</span><span class="ufuq-ar" lang="ar">تفحص البوابة ملفات Markdown في هذا المستودع وفق سياسات محتوى فلاي قاكا، وقد شُغّلت عند بناء هذا الموقع.</span></p>
  ${builtLine(data)}
</section>
<section aria-labelledby="k">
  <h2 id="k"><span class="ufuq-en">Checks and limits</span><span class="ufuq-ar" lang="ar">الفحوص والحدود</span></h2>
  <p class="panel-note"><span class="ufuq-en">A check that is not configured does not run, so a passing gate does not replace a manual review of that policy.</span><span class="ufuq-ar" lang="ar">الفحص غير المضبوط لا يعمل، لذلك لا تغني بوابة ناجحة عن مراجعة يدوية لتلك السياسة.</span></p>
  ${filters}
  ${tableWrap('Gate checks and limits', 'فحوص البوابة وحدودها', `<thead><tr>${th('Check', 'الفحص')}${th('Kind', 'النوع')}${th('Setting', 'الإعداد')}${th('Value', 'القيمة')}${th('Files', 'الملفات', 'ufuq-table__num')}${th('Findings', 'النتائج', 'ufuq-table__num')}</tr></thead><tbody>
${rows}
${emptyRow(6)}
</tbody>`, 'gate-table')}
  ${srcLine('scripts/gate.config.json', 'scripts/gate.mjs')}
</section>
<section aria-labelledby="r">
  <h2 id="r"><span class="ufuq-en">Findings</span><span class="ufuq-ar" lang="ar">النتائج</span></h2>
  <p><span class="ufuq-num">${g.errors}</span> ${bi('error(s)', 'أخطاء')} · <span class="ufuq-num">${g.warnings}</span> ${bi('warning(s)', 'تحذيرات')}</p>
  ${findings}
  ${srcLine('scripts/gate.mjs')}
</section>`;
}

export function renderSchedule(data) {
  const t = data.tasks;
  const rows = t.list
    .map(
      (x) =>
        `<tr><td class="mono ltr">${esc(x.id)}</td><td class="ltr">${esc(x.title)}</td><td class="mono ltr">${esc(x.schedule)}</td><td class="mono ltr">${esc(x.promptFile)}</td><td class="mono ltr nowrap">${esc(x.expiresAt || 'not found')}</td><td>${x.expiresAt ? `<span data-expires="${esc(x.expiresAt)}">${bi(`expires ${ltrDate(x.expiresAt)}`, `تنتهي في ${ltrDate(x.expiresAt)}`)}</span>` : bi('not found', 'غير موجود')}</td><td>${x.expiresAt ? `<span class="ufuq-badge ufuq-badge--neutral" data-expires-badge="${esc(x.expiresAt)}">${bi('Check the date', 'تحقق من التاريخ')}</span>` : badge('neutral', 'not found', 'غير موجود')}</td></tr>`,
    )
    .join('\n');
  return `<section aria-labelledby="t">
  <p class="ufuq-eyebrow"><span class="ufuq-en">Schedule</span><span class="ufuq-ar" lang="ar">الجدولة</span></p>
  <h1 id="t"><span class="ufuq-en">Scheduled tasks</span><span class="ufuq-ar" lang="ar">المهام المجدولة</span></h1>
  ${builtLine(data)}
</section>
<section id="tasks" aria-labelledby="q">
  <h2 id="q"><span class="ufuq-en">Qoder scheduled tasks</span><span class="ufuq-ar" lang="ar">مهام Qoder المجدولة</span></h2>
  <p class="panel-note"><span class="ufuq-en">The tasks stop at their expiry date. The days left are worked out in your browser from that date and today's date, and a task with fewer than 14 days remaining is marked "Expires soon". Without JavaScript only the date is shown.</span><span class="ufuq-ar" lang="ar">تتوقف المهام عند تاريخ انتهائها. تُحسب الأيام المتبقية في متصفحك من ذلك التاريخ ومن تاريخ اليوم، وتُوسم المهمة المتبقي لها أقل من 14 يومًا بعبارة «تنتهي قريبًا». وبلا JavaScript يظهر التاريخ فقط.</span></p>
  ${tableWrap('Qoder scheduled tasks', 'مهام Qoder المجدولة', `<thead><tr>${th('Task', 'المهمة')}${th('Title', 'العنوان')}${th('Schedule (cron)', 'الجدول (cron)')}${th('Prompt', 'الأمر')}${th('Expires at', 'تنتهي في')}${th('Days left', 'الأيام المتبقية')}${th('State', 'الحالة')}</tr></thead><tbody>
${rows}
</tbody>`)}
  <p>${bi('Generated on', 'أُنشئت في')} <span class="mono ltr">${esc(t.generatedAt || 'not found')}</span>. ${bi('To extend the tasks, a person runs this command; this site never runs it:', 'لتمديد المهام يشغّل شخص هذا الأمر، ولا يشغّله هذا الموقع أبدًا:')}</p>
  <code class="cmd" dir="ltr">${esc(t.regenerateWith)}</code>
  ${t.notes ? `<p class="src">${bi('The file says:', 'يقول الملف:')}</p>${out([t.notes])}` : ''}
  ${srcLine('.qoder/scheduled_tasks.json')}
</section>
<section aria-labelledby="pl">
  <h2 id="pl"><span class="ufuq-en">Plan</span><span class="ufuq-ar" lang="ar">الخطة</span></h2>
  <p><a href="plan.html">${bi('The phases, owner decisions and open items of PLAN.md are on the Plan page.', 'مراحل PLAN.md وقرارات المالك والبنود المفتوحة في صفحة الخطة.')}</a></p>
</section>`;
}

const head = (eyebrowEn, eyebrowAr, titleEn, titleAr, leadEn, leadAr, data) => `<section aria-labelledby="t">
  <p class="ufuq-eyebrow">${bi(eyebrowEn, eyebrowAr)}</p>
  <h1 id="t">${bi(titleEn, titleAr)}</h1>
  ${leadEn ? `<p class="lead">${bi(leadEn, leadAr)}</p>` : ''}
  ${data ? builtLine(data) : ''}
</section>`;

export function renderLimits(data) {
  const rows = data.limits.rows;
  const platforms = [...new Map(rows.map((r) => [r.id, r.platform])).entries()].map(([id, name]) => [id, name, name]);
  const verified = rows.filter((r) => r.verified).length;
  const third = rows.filter((r) => r.thirdParty).length;
  return `${head('Platform limits', 'حدود المنصات', 'Every limit, as the file has it', 'كل حد كما هو في الملف',
    'Text length limits per ad format, with the verified flag and the source link exactly as ads/platform-limits.json states them.',
    'حدود طول النص لكل صيغة إعلان، مع علامة التوثيق ورابط المصدر كما يذكرهما ads/platform-limits.json تمامًا.', data)}
<section aria-labelledby="l">
  <h2 id="l">${bi('Limits', 'الحدود')}</h2>
  <p><span class="ufuq-num">${verified} / ${rows.length}</span> ${bi('fields marked verified', 'حقلًا موسومًا موثّقًا')} · <span class="ufuq-num">${third}</span> ${bi('third-party claims', 'ادعاءات من طرف ثالث')}</p>
  <p class="panel-note">${bi('A limit counts as verified only when the file says so and names the platform\'s own documentation as its source. A claim the file marks as taken from a third-party guide is labelled as such. The site never sets a flag itself.', 'لا يُعدّ الحد موثّقًا إلا إذا نصّ الملف على ذلك وسمّى وثائق المنصة نفسها مصدرًا. وما يسمه الملف بأنه من دليل طرف ثالث يظهر بهذه الصفة. ولا يضع الموقع أي علامة بنفسه.')}</p>
  ${filterBar('limits-table', [
    ['platform', 'Platform', 'المنصة', platforms],
    ['status', 'Status', 'الحالة', [['verified', 'Verified', 'موثّق'], ['unverified', 'Not verified', 'غير موثّق'], ['nosource', 'Marked verified, no source', 'موسوم موثّقًا بلا مصدر']]],
    ['third', 'Third-party', 'طرف ثالث', [['yes', 'Third-party claim', 'ادعاء من طرف ثالث'], ['no', 'Not marked third-party', 'غير موسوم']]],
  ])}
  ${limitsTable(rows, 'limits-table')}
  ${data.limits.note ? `<p class="src">${bi('The file says:', 'يقول الملف:')}</p>${out([data.limits.note])}` : ''}
  ${srcLine('ads/platform-limits.json')}
</section>`;
}

export function renderPlaybook(data) {
  const pb = data.playbook;
  const toc = pb.toc.map((t) => `<li><a href="#${t.id}" lang="en">${esc(t.text)}</a></li>`).join('\n');
  return `${head('Ads playbook', 'دليل الإعلانات', 'The ads playbook', 'دليل الإعلانات',
    'How Claude and the owner run paid ads together, rendered from ads/PLAYBOOK.md. The text is English, as in the file.',
    'كيف يدير Claude والمالك الإعلانات المدفوعة معًا، معروضًا من ads/PLAYBOOK.md. النص بالإنجليزية كما في الملف.', data)}
${pb.withheld ? `<div class="ufuq-callout ufuq-callout--important callout-wrap"><p class="ufuq-callout__title">${bi('Some passages are withheld', 'بعض المقاطع محجوبة')}</p><p>${bi(`${pb.withheld} passage(s) name the owner's approved facts (a domain or an offer) and are replaced by a notice. The owner's facts stay in ads/approved-facts.json and are never copied to this site.`, `${pb.withheld} مقاطع تذكر الحقائق التي اعتمدها المالك (نطاقًا أو عرضًا) واستُبدلت بإشعار. تبقى حقائق المالك في ads/approved-facts.json ولا تُنسخ إلى هذا الموقع.`)}</p></div>` : ''}
<nav class="toc" aria-label="Contents" data-label-en="Contents" data-label-ar="المحتويات">
  <h2 class="toc-title">${bi('Contents', 'المحتويات')}</h2>
  <ol>
${toc}
  </ol>
</nav>
<article class="playbook" lang="en" dir="ltr">
${pb.html}
</article>
<p><a href="#main">${bi('Back to top', 'إلى الأعلى')}</a></p>
${srcLine('ads/PLAYBOOK.md')}`;
}

export function renderPlan(data) {
  const { phases, decisions, open } = data.plan;
  const done = decisions.filter((d) => d.done).length;
  const hasStatus = phases.some((p) => p.status);
  const cards = phases
    .map((p) => {
      const status = p.status ? badge('brand', p.status, p.status) : badge('neutral', 'Status not written in PLAN.md', 'الحالة غير مكتوبة في PLAN.md');
      const links = p.links.length
        ? `<p class="phase-links">${bi('Linked in the file:', 'روابط في الملف:')} ${p.links.map((l) => `<a href="${esc(l.url)}" rel="noopener noreferrer">${esc(l.text)}</a>`).join(' · ')}</p>`
        : '';
      return `<li class="ufuq-card phase"><div class="ufuq-card__body">
    <h3 class="ltr" dir="ltr">${esc(p.phase)}</h3>
    <p>${status}</p>
    <dl class="phase-dl"><div><dt>${bi('Who', 'من')}</dt><dd class="ltr" dir="ltr" lang="en">${esc(p.who)}</dd></div><div><dt>${bi('What', 'ماذا')}</dt><dd class="ltr" dir="ltr" lang="en">${esc(p.what)}</dd></div><div><dt>${bi('Done when', 'يكتمل عندما')}</dt><dd class="ltr" dir="ltr" lang="en">${esc(p.doneWhen)}</dd></div></dl>
    ${links}
  </div></li>`;
    })
    .join('\n');
  const decisionItems = decisions
    .map((d) => `<li>${d.done ? badge('success', 'Done', 'تم') : badge('warning', 'Open', 'مفتوح')} <span class="ltr" dir="ltr" lang="en">${esc(d.text)}</span></li>`)
    .join('\n');
  const openItems = open.map((o) => `<li><span class="ltr" dir="ltr" lang="en">${esc(o)}</span></li>`).join('\n');
  return `${head('Plan', 'الخطة', 'Plan progress', 'تقدم الخطة',
    'The phases of PLAN.md in order, then the owner decisions (checkboxes in the file) and the open items.',
    'مراحل PLAN.md بالترتيب، ثم قرارات المالك (مربعات الاختيار في الملف) والبنود المفتوحة.', data)}
<section aria-labelledby="pr">
  <h2 id="pr">${bi('Progress', 'التقدم')}</h2>
  <p><span class="ufuq-num">${done} / ${decisions.length}</span> ${bi('owner decisions ticked in PLAN.md', 'قرارات للمالك معلّمة في PLAN.md')}</p>
  <progress class="ufuq-progress" max="${Math.max(decisions.length, 1)}" value="${done}" aria-label="Owner decisions ticked: ${done} of ${decisions.length}"></progress>
  <p class="panel-note">${hasStatus
    ? bi('Each phase shows the status the file writes in its Status column.', 'تعرض كل مرحلة الحالة المكتوبة في عمود الحالة بالملف.')
    : bi('PLAN.md has no Status column, so no phase is marked done or in progress here: the page never decides that. Each phase shows what the file says, in order. If the owner adds a Status column to the Phases table, it appears on these cards after the next build.', 'لا يحتوي PLAN.md على عمود للحالة، لذلك لا تُوسم أي مرحلة بأنها منجزة أو جارية هنا: لا تقرر الصفحة ذلك. تعرض كل مرحلة ما يكتبه الملف بالترتيب. وإذا أضاف المالك عمود حالة إلى جدول المراحل ظهر على هذه البطاقات بعد البناء التالي.')}</p>
</section>
<section id="phases" aria-labelledby="ph">
  <h2 id="ph">${bi('Phases', 'المراحل')}</h2>
  ${phases.length ? `<ol class="phases">\n${cards}\n</ol>` : `<div class="ufuq-empty"><p class="ufuq-empty__title">${bi('No phases found', 'لم يُعثر على مراحل')}</p><p>${bi('PLAN.md has no Phases table this page can read.', 'لا يحوي PLAN.md جدول مراحل تستطيع الصفحة قراءته.')}</p></div>`}
</section>
<section id="decisions" aria-labelledby="d">
  <h2 id="d">${bi('Owner decisions', 'قرارات المالك')}</h2>
  ${decisions.length ? `<ul class="checklist">${decisionItems}</ul>` : `<p>${bi('None found.', 'لا شيء.')}</p>`}
  <h3>${bi('Open items', 'البنود المفتوحة')}</h3>
  ${open.length ? `<ul class="checklist">${openItems}</ul>` : `<p>${bi('None found.', 'لا شيء.')}</p>`}
  ${srcLine('PLAN.md')}
</section>`;
}

export function renderChecks(data) {
  const cmds = data.commands;
  const rows = cmds
    .map((c) => {
      const pk = c.script === null ? '' : c.scriptExists ? badge('success', 'script in package.json', 'السكربت في package.json') : badge('danger', 'not in package.json', 'ليس في package.json');
      return `<li class="ufuq-card cmd-card"><div class="ufuq-card__body">
    <h3>${esc(c.task)}</h3>
    <div class="cmdrow"><code class="cmd" dir="ltr">${esc(c.command)}</code>${copyBtn(c.command)}<span class="copy-status" role="status" aria-live="polite"></span></div>
    ${c.note ? `<p class="panel-note ltr" dir="ltr" lang="en">${esc(c.note)}</p>` : ''}
    ${pk ? `<p>${pk}</p>` : ''}
  </div></li>`;
    })
    .join('\n');
  return `${head('Run the checks', 'تشغيل الفحوص', 'How to run the checks', 'كيف تشغّل الفحوص',
    'The commands in the Commands table of CLAUDE.md, in the order the file lists them. Copy one and run it in a terminal at the root of the scout checkout.',
    'الأوامر الواردة في جدول Commands في CLAUDE.md بترتيب الملف. انسخ أمرًا وشغّله في طرفية عند جذر نسخة scout.', data)}
<div class="ufuq-callout ufuq-callout--caution callout-wrap"><p class="ufuq-callout__title">${bi('This site runs nothing', 'هذا الموقع لا يشغّل شيئًا')}</p><p>${bi('The buttons only copy text to your clipboard. Nothing is sent anywhere and no command runs from this page.', 'تنسخ الأزرار النص إلى الحافظة فقط. لا يُرسل شيء إلى أي مكان ولا يعمل أي أمر من هذه الصفحة.')}</p></div>
${data.requirements ? `<p class="panel-note ltr" dir="ltr" lang="en">${esc(data.requirements)}</p>` : ''}
<section aria-labelledby="c">
  <h2 id="c">${bi('Commands', 'الأوامر')}</h2>
  ${cmds.length ? `<ul class="cmd-list">\n${rows}\n</ul>` : `<div class="ufuq-empty"><p class="ufuq-empty__title">${bi('No commands found', 'لم يُعثر على أوامر')}</p><p>${bi('CLAUDE.md has no Commands table this page can read.', 'لا يحوي CLAUDE.md جدول أوامر تستطيع الصفحة قراءته.')}</p></div>`}
  ${srcLine('CLAUDE.md', 'package.json')}
</section>`;
}

const jsonForScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderCopycheck(data) {
  const cc = data.copycheck;
  const opts = cc.formats.map((f) => `<option value="${esc(f.id)}">${esc(f.platform)}${f.verified ? '' : ' (limits not verified)'}</option>`).join('');
  return `${head('Copy self-check', 'فحص النص ذاتيًا', 'Check ad text in your browser', 'افحص نص الإعلان في متصفحك',
    'Paste ad text and see it against the length limits and the banned-claim patterns that tools/ad-copy-lint.mjs uses.',
    'الصق نص الإعلان وقارنه بحدود الطول وأنماط الادعاءات الممنوعة التي يستخدمها tools/ad-copy-lint.mjs.', null)}
<div class="ufuq-callout ufuq-callout--important callout-wrap"><p class="ufuq-callout__title">${bi('A subset of the real checker', 'جزء من الفاحص الحقيقي')}</p><p>${bi('This page checks length, banned status and outcome claims, anything that looks like a price, the word free, and the not-affiliated disclaimer. It cannot check prices, offers, landing domains or tracking tags, because those come from the owner\'s approved facts, which are not on this site. Run node tools/ad-copy-lint.mjs before review: it is the checker that counts.', 'تفحص هذه الصفحة الطول وادعاءات الصفة الرسمية والنتائج المضمونة وأي نص يشبه سعرًا وكلمة «مجاني» وعبارة عدم التبعية. ولا تستطيع فحص الأسعار أو العروض أو نطاقات الصفحات المقصودة أو وسوم التتبع لأنها من حقائق المالك المعتمدة وهي ليست على هذا الموقع. شغّل node tools/ad-copy-lint.mjs قبل المراجعة: فهو الفاحص المعتمد.')} ${bi('Your text stays in this page: nothing is sent, stored or logged.', 'يبقى نصك في هذه الصفحة: لا يُرسل ولا يُخزَّن ولا يُسجَّل.')}</p></div>
<noscript><p class="ufuq-notice">${bi('This check needs JavaScript.', 'يحتاج هذا الفحص إلى JavaScript.')}</p></noscript>
<form class="cc" id="cc" hidden novalidate>
  <div class="cc-grid">
    <div class="ufuq-field"><label class="ufuq-field__label" for="cc-format">${bi('Ad format', 'صيغة الإعلان')}</label><select class="ufuq-select" id="cc-format">${opts}</select></div>
    <div class="ufuq-field"><label class="ufuq-field__label" for="cc-field">${bi('Field', 'الحقل')}</label><select class="ufuq-select" id="cc-field"></select></div>
    <div class="ufuq-field"><label class="ufuq-field__label" for="cc-lang">${bi('Language of the text', 'لغة النص')}</label><select class="ufuq-select" id="cc-lang"><option value="en">English</option><option value="ar">العربية</option></select></div>
  </div>
  <div class="ufuq-field"><label class="ufuq-field__label" for="cc-text">${bi('Text, one item per line', 'النص، عنصر في كل سطر')}</label><textarea class="ufuq-textarea" id="cc-text" rows="6" dir="auto" spellcheck="false" aria-describedby="cc-help"></textarea><p class="ufuq-field__help" id="cc-help">${bi('Each line is counted on its own, as the checker counts each headline or description.', 'يُحسب كل سطر وحده، كما يحسب الفاحص كل عنوان أو وصف.')}</p></div>
  <label class="ufuq-choice cc-check"><input type="checkbox" id="cc-elsewhere"> <span>${bi('The disclaimer is shown in the creative or on the landing page, not in this text', 'العبارة التحذيرية تظهر في التصميم أو في الصفحة المقصودة وليست في هذا النص')}</span></label>
</form>
<section aria-labelledby="r" aria-live="polite">
  <h2 id="r">${bi('Result', 'النتيجة')}</h2>
  <div id="cc-result"><p class="panel-note">${bi('Paste some text to see the result.', 'الصق نصًا لترى النتيجة.')}</p></div>
</section>
<script type="application/json" id="cc-data">${jsonForScript(cc)}</script>
${srcLine('ads/platform-limits.json', 'tools/ad-copy-lint.mjs')}`;
}

export function render404(data) {
  return `<section aria-labelledby="t">
  <p class="ufuq-eyebrow">${bi('Error 404', 'الخطأ 404')}</p>
  <h1 id="t">${bi('Page not found', 'الصفحة غير موجودة')}</h1>
  <p class="lead">${bi('There is no page at this address. Pick one from the menu or start from the overview.', 'لا توجد صفحة في هذا العنوان. اختر صفحة من القائمة أو ابدأ من النظرة العامة.')}</p>
  <p><a class="ufuq-btn ufuq-btn--primary" href="/index.html">${bi('Go to the overview', 'إلى النظرة العامة')}</a></p>
</section>`;
}

export function renderPages(data) {
  const t = {
    'index.html': ['Overview', 'نظرة عامة', 'The state of the Fly GACA ads and content guardrails, read from the repository.', renderOverview(data)],
    'ads.html': ['Ads', 'الإعلانات', 'Approved facts status, platform limits and ad copy checker results.', renderAds(data)],
    'limits.html': ['Limits', 'الحدود', 'Every ad platform text limit with its verified flag and source.', renderLimits(data)],
    'playbook.html': ['Playbook', 'دليل الإعلانات', 'The ads playbook with a table of contents.', renderPlaybook(data)],
    'gate.html': ['Content gate', 'بوابة المحتوى', 'The checks and limits the content gate runs and what it found.', renderGate(data)],
    'plan.html': ['Plan', 'الخطة', 'The phases, owner decisions and open items of PLAN.md.', renderPlan(data)],
    'schedule.html': ['Schedule', 'الجدولة', 'Qoder scheduled tasks with expiry.', renderSchedule(data)],
    'checks.html': ['Run the checks', 'تشغيل الفحوص', 'The commands from CLAUDE.md with copy buttons.', renderChecks(data)],
    'copycheck.html': ['Copy self-check', 'فحص النص ذاتيًا', 'Check ad text against the length limits and banned claims in your browser.', renderCopycheck(data)],
    '404.html': ['Page not found', 'الصفحة غير موجودة', 'There is no page at this address.', render404(data)],
  };
  return Object.fromEntries(
    Object.entries(t).map(([file, [en, ar, desc, body]]) => [file, shell(file, en, ar, desc, body, data)]),
  );
}

/* ------------------------------------------------------------------ files */

export async function buildFiles(builtOn) {
  const data = await collect(builtOn);
  const files = new Map();
  for (const [f, html] of Object.entries(renderPages(data))) files.set(f, html);
  files.set('data.json', JSON.stringify(data, null, 2) + '\n');
  for (const [dest, src] of Object.entries(GENERATED_FROM_TOOLS)) files.set(dest, readFileSync(join(root, src), 'utf8'));
  return files;
}

function listSite() {
  const base = join(root, SITE);
  const out = [];
  const rec = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) rec(p);
      else out.push(relative(base, p).split('\\').join('/'));
    }
  };
  if (existsSync(base)) rec(base);
  return out.sort();
}

function today() {
  return process.env.SCOUT_BUILD_DATE || new Date().toISOString().slice(0, 10);
}

async function main() {
  const check = process.argv.includes('--check');
  let builtOn = today();
  if (check) {
    // Compare against the date already recorded, so a new day alone never makes the site stale.
    try {
      builtOn = JSON.parse(readFileSync(join(root, SITE, 'data.json'), 'utf8')).builtOn || builtOn;
    } catch { /* missing or unreadable: the comparison below reports it */ }
  }
  const files = await buildFiles(builtOn);
  if (!check) {
    for (const [f, text] of files) {
      const p = join(root, SITE, f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    const missing = VENDORED.filter((f) => !exists(`${SITE}/${f}`));
    if (missing.length) console.warn(`warning: vendored files missing from site/: ${missing.join(', ')}`);
    console.log(`wrote site/ (${files.size} generated files, built ${builtOn})`);
    return;
  }
  const problems = [];
  for (const [f, text] of files) {
    const p = join(root, SITE, f);
    if (!existsSync(p)) problems.push(`missing: site/${f}`);
    else if (readFileSync(p, 'utf8') !== text) problems.push(`stale: site/${f}`);
  }
  const known = new Set([...files.keys(), ...VENDORED]);
  for (const f of listSite()) if (!known.has(f)) problems.push(`unexpected file: site/${f}`);
  for (const f of VENDORED) if (!exists(`${SITE}/${f}`)) problems.push(`missing vendored file: site/${f}`);
  if (problems.length) {
    console.error(`site/ is out of date: run node tools/build-site.mjs\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('site/ is up to date');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // A checker that cannot run is a build problem worth failing on; findings are not.
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(2);
  });
}
