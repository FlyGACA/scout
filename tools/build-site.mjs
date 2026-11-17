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
import { lintCampaign } from './ad-copy-lint.mjs';
import { runGate, loadConfig, matchFiles, CHECK_NAMES } from '../scripts/gate.mjs';

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

export function parsePlan(text) {
  const lines = text.split(/\r?\n/);
  const phases = [];
  const decisions = [];
  const open = [];
  let section = '';
  for (const line of lines) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (section === 'Phases' && /^\|\s*\*\*\d/.test(line)) {
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => plainMd(c));
      if (cells.length >= 4) phases.push({ phase: cells[0], who: cells[1], what: cells[2], doneWhen: cells[3] });
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
        verified,
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
  return {
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
    sources: ['ads/approved-facts.json', 'ads/platform-limits.json', 'ads/copy/', 'scripts/gate.config.json', 'scripts/gate.mjs', '.qoder/scheduled_tasks.json', 'PLAN.md'],
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
const tableWrap = (labelEn, labelAr, inner) =>
  `<div class="ufuq-table-wrap table-wrap" tabindex="0" role="region" aria-label="${esc(labelEn)}" data-label-en="${esc(labelEn)}" data-label-ar="${esc(labelAr)}"><table class="ufuq-table">${inner}</table></div>`;
const out = (lines) => `<div class="out" dir="ltr" lang="en">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`;

const PAGES = [
  ['index.html', 'Overview', 'نظرة عامة'],
  ['ads.html', 'Ads', 'الإعلانات'],
  ['gate.html', 'Content gate', 'بوابة المحتوى'],
  ['schedule.html', 'Schedule and plan', 'الجدولة والخطة'],
];

function shell(file, titleEn, titleAr, descEn, main, data) {
  const nav = PAGES.map(
    ([f, en, ar]) => `<a href="${f}"${f === file ? ' aria-current="page"' : ''}>${bi(en, ar)}</a>`,
  ).join('');
  const sibs = SIBLINGS.map(([href, en, ar]) => `<li><a href="${href}">${bi(en, ar)}</a></li>`).join('\n    ');
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titleEn)} · ${esc(titleAr)} — Scout</title>
<meta name="description" content="${esc(descEn)}">
<link rel="icon" href="ufuq/scout-mark.svg">
<link rel="stylesheet" href="ufuq/ufuq.css">
<link rel="stylesheet" href="ufuq/ufuq.components.css">
<link rel="stylesheet" href="site.css">
<script src="ufuq/ufuq.shell.js"></script>
<script src="scout.js" defer></script>
</head>
<body class="page">
<header class="ufuq-shell">
  <a class="ufuq-shell__brand" href="index.html"><img class="on-night" src="ufuq/scout-mark.svg" alt="" width="32" height="32"><img class="on-day" src="ufuq/scout-mark-ink.svg" alt="" width="32" height="32"><span class="ufuq-en">Scout</span><span class="ufuq-ar" lang="ar">الكشّاف</span></a>
  <nav class="ufuq-shell__nav" aria-label="Pages" data-label-en="Pages" data-label-ar="الصفحات">${nav}</nav>
  <div class="ufuq-shell__tools">
    <span class="ufuq-shell__who" data-shell-who hidden></span>
    <a class="ufuq-shell__tool" data-shell-out hidden><span class="ufuq-en">Sign out</span><span class="ufuq-ar" lang="ar">خروج</span></a>
    <button type="button" class="ufuq-shell__tool" data-shell-theme aria-pressed="false"><span class="ufuq-en">Day / Night</span><span class="ufuq-ar" lang="ar">نهاري / ليلي</span></button>
    <button type="button" class="ufuq-shell__tool" data-shell-lang><span class="ufuq-en" lang="ar">العربية</span><span class="ufuq-ar" lang="en">English</span></button>
  </div>
</header>
<main class="ufuq-container wrap">
${main}
</main>
<footer class="ufuq-shell-foot">
  <a class="ufuq-shell-foot__family" href="${FAMILY_HOME}"><img src="ufuq/flygaca-mark.png" alt="" width="48" height="48"><span class="ufuq-en">Part of Fly GACA</span><span class="ufuq-ar" lang="ar">جزء من فلاي قاكا</span></a>
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
    <div><dt>${bi('Platform limits verified', 'حدود المنصات الموثّقة')}</dt><dd><span class="big ufuq-num">${verified} / ${lim.length}</span> <span class="more">${bi('fields', 'حقلًا')}</span></dd><dd class="src"><a href="ads.html#limits">${bi('Details', 'التفاصيل')}</a> · ${code('ads/platform-limits.json')}</dd></div>
    <div><dt>${bi('Ad copy files without errors', 'ملفات نص الإعلان بلا أخطاء')}</dt><dd><span class="big ufuq-num">${copyPass} / ${data.copy.length}</span> <span class="more">${bi(`${copyWarn} warning(s)`, `${copyWarn} تحذيرات`)}</span></dd><dd class="src"><a href="ads.html#copy">${bi('Details', 'التفاصيل')}</a> · ${code('ads/copy/')}</dd></div>
    <div><dt>${bi('Content gate', 'بوابة المحتوى')}</dt><dd>${badge(gateTone, gateWordsEn, gateWordsAr)} <span class="more ufuq-num">${data.gate.errors} / ${data.gate.warnings}</span> <span class="more">${bi('errors / warnings', 'أخطاء / تحذيرات')}</span></dd><dd class="src"><a href="gate.html">${bi('Details', 'التفاصيل')}</a> · ${code('scripts/gate.mjs')}</dd></div>
    <div><dt>${bi('Soonest Qoder task expiry', 'أقرب انتهاء لمهام Qoder')}</dt><dd>${expiresBlock(soon)} <span data-expires-badge="${esc(soon || '')}" class="ufuq-badge ufuq-badge--neutral">${bi('Check the date', 'تحقق من التاريخ')}</span></dd><dd class="src"><a href="schedule.html">${bi('Details', 'التفاصيل')}</a> · ${code('.qoder/scheduled_tasks.json')}</dd></div>
    <div><dt>${bi('Owner decisions still open', 'قرارات المالك المفتوحة')}</dt><dd><span class="big ufuq-num">${open} / ${data.plan.decisions.length}</span></dd><dd class="src"><a href="schedule.html#plan">${bi('Details', 'التفاصيل')}</a> · ${code('PLAN.md')}</dd></div>
  </dl>
</section>
<section aria-labelledby="p">
  <h2 id="p"><span class="ufuq-en">Pages</span><span class="ufuq-ar" lang="ar">الصفحات</span></h2>
  <div class="cards">
    <article class="ufuq-card ufuq-card--interactive"><h3 class="ufuq-card__title"><span class="ufuq-en">Ads</span><span class="ufuq-ar" lang="ar">الإعلانات</span></h3><p class="ufuq-card__body"><span class="ufuq-en">Approved facts (status only), platform text limits and the copy checker's result for each file.</span><span class="ufuq-ar" lang="ar">الحقائق المعتمدة (الحالة فقط) وحدود نصوص المنصات ونتيجة فاحص النص لكل ملف.</span></p><div class="ufuq-card__actions"><a class="ufuq-btn ufuq-btn--primary" href="ads.html"><span class="ufuq-en">Open ads</span><span class="ufuq-ar" lang="ar">افتح الإعلانات</span></a></div></article>
    <article class="ufuq-card ufuq-card--interactive"><h3 class="ufuq-card__title"><span class="ufuq-en">Content gate</span><span class="ufuq-ar" lang="ar">بوابة المحتوى</span></h3><p class="ufuq-card__body"><span class="ufuq-en">Which checks the gate runs, and what it found in the Markdown.</span><span class="ufuq-ar" lang="ar">الفحوص التي تجريها البوابة وما وجدته في ملفات Markdown.</span></p><div class="ufuq-card__actions"><a class="ufuq-btn ufuq-btn--secondary" href="gate.html"><span class="ufuq-en">Open the gate</span><span class="ufuq-ar" lang="ar">افتح البوابة</span></a></div></article>
    <article class="ufuq-card ufuq-card--interactive"><h3 class="ufuq-card__title"><span class="ufuq-en">Schedule and plan</span><span class="ufuq-ar" lang="ar">الجدولة والخطة</span></h3><p class="ufuq-card__body"><span class="ufuq-en">The Qoder scheduled tasks with the days left, and the plan's phases as PLAN.md states them.</span><span class="ufuq-ar" lang="ar">مهام Qoder المجدولة مع الأيام المتبقية، ومراحل الخطة كما يذكرها PLAN.md.</span></p><div class="ufuq-card__actions"><a class="ufuq-btn ufuq-btn--secondary" href="schedule.html"><span class="ufuq-en">Open the schedule</span><span class="ufuq-ar" lang="ar">افتح الجدولة</span></a></div></article>
  </div>
</section>`;
}

export function renderAds(data) {
  const factRows = data.facts.keys
    .map((k) => `<li>${esc(k.key)} · ${esc(k.kind)} · ${k.count}</li>`)
    .join('');
  const limitRows = data.limits.rows
    .map((r) => {
      const status = r.verified
        ? r.source
          ? `${badge('success', 'Verified', 'موثّق')}`
          : `${badge('danger', 'Marked verified, no source', 'موسوم موثّقًا بلا مصدر')}`
        : badge('warning', 'Not verified', 'غير موثّق');
      const source = r.verified && r.source
        ? `<a href="${esc(r.source)}" rel="noopener noreferrer">${esc(r.source)}</a>`
        : bi('none', 'لا يوجد');
      const third = r.thirdParty ? ` ${badge('caution', 'Third-party claim', 'ادعاء من طرف ثالث')}` : '';
      return `<tr><td class="ltr">${esc(r.platform)}</td><td class="mono ltr">${esc(r.field)}</td><td class="mono ltr">${esc(r.limit)}</td><td>${status}${third}</td><td class="ltr">${source}</td></tr>`;
    })
    .join('\n');
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
  ${tableWrap('Platform limits', 'حدود المنصات', `<thead><tr>${th('Platform', 'المنصة')}${th('Field', 'الحقل')}${th('Limit (characters)', 'الحد (بالأحرف)')}${th('Status', 'الحالة')}${th('Source', 'المصدر')}</tr></thead><tbody>
${limitRows}
</tbody>`)}
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

export function renderGate(data) {
  const g = data.gate;
  const rows = g.checks
    .map(
      (c) =>
        `<tr><td class="mono ltr">${esc(c.name)}</td><td>${c.on ? badge('success', 'On', 'مفعّل') : badge('neutral', 'Not configured', 'غير مضبوط')}</td><td class="ufuq-table__num">${c.on ? c.files : '–'}</td><td class="mono ltr">${esc(c.settings || (c.on ? '' : ''))}</td><td class="ufuq-table__num">${g.findings.filter((f) => f.check === c.name).length}</td></tr>`,
    )
    .join('\n');
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
  <h2 id="k"><span class="ufuq-en">Checks</span><span class="ufuq-ar" lang="ar">الفحوص</span></h2>
  <p class="panel-note"><span class="ufuq-en">A check that is not configured does not run, so a passing gate does not replace a manual review of that policy.</span><span class="ufuq-ar" lang="ar">الفحص غير المضبوط لا يعمل، لذلك لا تغني بوابة ناجحة عن مراجعة يدوية لتلك السياسة.</span></p>
  ${tableWrap('Gate checks', 'فحوص البوابة', `<thead><tr>${th('Check', 'الفحص')}${th('State', 'الحالة')}${th('Files', 'الملفات', 'ufuq-table__num')}${th('Settings', 'الإعدادات')}${th('Findings', 'النتائج', 'ufuq-table__num')}</tr></thead><tbody>
${rows}
</tbody>`)}
  ${srcLine('scripts/gate.config.json')}
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
  const phases = data.plan.phases
    .map((p) => `<tr><td class="ltr"><strong>${esc(p.phase)}</strong></td><td class="ltr">${esc(p.who)}</td><td class="ltr">${esc(p.what)}</td><td class="ltr">${esc(p.doneWhen)}</td></tr>`)
    .join('\n');
  const decisions = data.plan.decisions
    .map((d) => `<li>${d.done ? badge('success', 'Done', 'تم') : badge('warning', 'Open', 'مفتوح')} <span class="ltr" dir="ltr" lang="en">${esc(d.text)}</span></li>`)
    .join('\n');
  const open = data.plan.open.map((o) => `<li class="ltr" dir="ltr" lang="en">${esc(o)}</li>`).join('\n');
  return `<section aria-labelledby="t">
  <p class="ufuq-eyebrow"><span class="ufuq-en">Schedule and plan</span><span class="ufuq-ar" lang="ar">الجدولة والخطة</span></p>
  <h1 id="t"><span class="ufuq-en">Scheduled tasks and plan progress</span><span class="ufuq-ar" lang="ar">المهام المجدولة وتقدم الخطة</span></h1>
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
<section id="plan" aria-labelledby="pl">
  <h2 id="pl"><span class="ufuq-en">Plan progress</span><span class="ufuq-ar" lang="ar">تقدم الخطة</span></h2>
  <p class="panel-note"><span class="ufuq-en">PLAN.md has no status column, so each phase is shown as the file writes it, with its "Done when" text. The page does not mark a phase done on its own.</span><span class="ufuq-ar" lang="ar">لا يحتوي PLAN.md على عمود للحالة، لذلك تظهر كل مرحلة كما كتبها الملف مع نص «يكتمل عندما». ولا تضع الصفحة علامة الإنجاز على أي مرحلة من تلقاء نفسها.</span></p>
  ${tableWrap('Plan phases', 'مراحل الخطة', `<thead><tr>${th('Phase', 'المرحلة')}${th('Who', 'من')}${th('What', 'ماذا')}${th('Done when', 'يكتمل عندما')}</tr></thead><tbody>
${phases}
</tbody>`)}
  <h3>${bi('Owner decisions', 'قرارات المالك')}</h3>
  <ul class="checklist">${decisions}</ul>
  <h3>${bi('Open items', 'البنود المفتوحة')}</h3>
  <ul class="checklist">${open}</ul>
  ${srcLine('PLAN.md')}
</section>`;
}

export function renderPages(data) {
  const t = {
    'index.html': ['Overview', 'نظرة عامة', 'The state of the Fly GACA ads and content guardrails, read from the repository.', renderOverview(data)],
    'ads.html': ['Ads', 'الإعلانات', 'Approved facts status, platform limits and ad copy checker results.', renderAds(data)],
    'gate.html': ['Content gate', 'بوابة المحتوى', 'The checks the content gate runs and what it found.', renderGate(data)],
    'schedule.html': ['Schedule and plan', 'الجدولة والخطة', 'Qoder scheduled tasks with expiry, and plan progress.', renderSchedule(data)],
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
