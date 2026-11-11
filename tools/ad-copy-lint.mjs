#!/usr/bin/env node
// Checks ad copy before a person reviews it. Deterministic, no network, no dependencies.
//   node tools/ad-copy-lint.mjs                 lint every ads/copy/*.json
//   node tools/ad-copy-lint.mjs path/to/x.json  lint one file
// Exit 1 when any error is found. Warnings never fail.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Strip Arabic diacritics and tatweel, fold Latin case, collapse spaces.
export function norm(s) {
  return String(s)
    .normalize('NFC')
    .replace(/[ً-ٰٟـ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const BANNED = [
  // [pattern on normalized text, what it implies]
  [/\b(official|officially)\b/, 'implies official status'],
  [/\b(approved|endorsed|accredited|certified|authori[sz]ed|licensed)\b/, 'implies approval or accreditation'],
  [/\b(guarantee|guaranteed|guarantees)\b|100\s?%/, 'promises an outcome'],
  [/رسمي|رسميه|رسمية/, 'يوحي بصفة رسمية (implies official status)'],
  [/معتمد|معتمده|معتمدة|مرخص|مرخصه|مرخصة/, 'يوحي بالاعتماد (implies approval)'],
  [/مضمون|مضمونه|مضمونة|ضمان|نضمن/, 'يعد بنتيجة (promises an outcome)'],
];
const PRICE = /(?:[\d٠-٩][\d٠-٩,.]*\s*(?:sar|usd|ريال|ر\.?\s?س|﷼|\$))|(?:(?:sar|usd|﷼|\$)\s*[\d٠-٩][\d٠-٩,.]*)/g;
const FREE = /\bfree\b|مجان/;
const MARKER = {
  en: /not affiliated with/,
  ar: /غير تابعة? (?:ل\s*gaca|للهيئة العامة للطيران المدني)/,
};

function hostAllowed(host, domains) {
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

export function lintCampaign(campaign, { facts, limits, file = 'campaign' }) {
  const out = [];
  const add = (level, where, msg) => out.push({ level, where: `${file}:${where}`, msg });
  const approved = Object.fromEntries(
    Object.entries(facts.disclaimers).map(([lang, list]) => [lang, list.map(norm)]),
  );
  const prices = new Set((facts.prices || []).map((p) => norm(p.display ?? p)));

  if (!campaign.campaign || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(campaign.campaign)) {
    add('error', 'campaign', 'campaign must be a lowercase slug like captain-adel-free-test');
  }
  const offer = facts.offers[campaign.offer];
  if (!offer) add('error', 'offer', `offer "${campaign.offer}" is not in ads/approved-facts.json`);

  const variants = Array.isArray(campaign.variants) ? campaign.variants : [];
  if (!variants.length) add('error', 'variants', 'no variants');
  const ids = new Set();
  const langs = new Set();

  for (const v of variants) {
    const at = v.id || '(no id)';
    if (!v.id || ids.has(v.id)) add('error', at, 'every variant needs a unique id');
    ids.add(v.id);
    const fmt = limits[v.format];
    if (!fmt) {
      add('error', at, `unknown format "${v.format}" (see ads/platform-limits.json)`);
      continue;
    }
    if (v.lang !== 'en' && v.lang !== 'ar') add('error', at, 'lang must be "en" or "ar"');
    langs.add(v.lang);

    const texts = [];
    for (const [field, value] of Object.entries(v.fields || {})) {
      const rule = fmt.fields[field];
      if (!rule) {
        add('error', at, `${v.format} has no field "${field}"`);
        continue;
      }
      for (const text of [].concat(value)) {
        texts.push(text);
        const n = [...String(text).trim()].length;
        const tag = fmt.verified ? '' : ' (limit not yet verified)';
        if (rule.max && n > rule.max) add('error', `${at}.${field}`, `${n} characters, max ${rule.max}${tag}`);
        else if (rule.recommended && n > rule.recommended) {
          add('warn', `${at}.${field}`, `${n} characters, gets cut off after ${rule.recommended}${tag}`);
        }
      }
    }

    // Claims: scan with the approved disclaimers removed, since they contain "official"/"رسمي".
    let scan = norm(texts.join(' \n '));
    for (const d of Object.values(approved).flat()) scan = scan.split(d).join(' ');
    for (const [re, why] of BANNED) {
      const m = scan.match(re);
      if (m) add('error', at, `"${m[0]}" ${why}`);
    }
    for (const m of scan.match(PRICE) || []) {
      if (!prices.has(norm(m))) add('error', at, `price "${m.trim()}" is not in approved-facts.json prices`);
    }
    if (FREE.test(scan) && !(offer && offer.free)) add('error', at, 'says free, but the offer is not marked free');

    // Disclaimer: in the copy, or declared as carried by the creative/landing page (checked by a person).
    const all = norm(texts.join(' '));
    const marker = MARKER[v.lang];
    if (marker && !marker.test(all)) {
      if (v.disclaimer_in === 'creative' || v.disclaimer_in === 'landing') {
        add('warn', at, `no disclaimer in the text; check it is visible in the ${v.disclaimer_in}`);
      } else {
        add('error', at, 'no "not affiliated with GACA" disclaimer (or set disclaimer_in: "creative" | "landing")');
      }
    }

    // Landing URL and tracking.
    let url;
    try {
      url = new URL(v.url);
    } catch {
      add('error', at, 'url is missing or invalid');
      continue;
    }
    if (url.protocol !== 'https:') add('error', at, 'url must be https');
    if (!hostAllowed(url.hostname, facts.landing_domains)) {
      add('error', at, `landing domain ${url.hostname} is not in approved-facts.json`);
    }
    const p = url.searchParams;
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) {
      if (!p.get(k)) add('error', at, `url has no ${k}`);
    }
    if (p.get('utm_source') && !new RegExp(`^(${fmt.utm_source})$`).test(p.get('utm_source'))) {
      add('error', at, `utm_source "${p.get('utm_source')}" does not match ${v.format} (${fmt.utm_source})`);
    }
    if (p.get('utm_campaign') && p.get('utm_campaign') !== campaign.campaign) {
      add('error', at, `utm_campaign should be "${campaign.campaign}"`);
    }
  }

  if (langs.has('en') !== langs.has('ar')) {
    add('warn', 'variants', 'only one language; FlyGACA ships English and Arabic together');
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const facts = loadJson(join(root, 'ads/approved-facts.json'));
  const limits = loadJson(join(root, 'ads/platform-limits.json'));
  const args = process.argv.slice(2);
  const dir = join(root, 'ads/copy');
  const files = args.length
    ? args
    : readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  let errors = 0;
  for (const f of files) {
    const findings = lintCampaign(loadJson(f), { facts, limits, file: basename(f) });
    for (const x of findings) console.log(`${x.level.padEnd(5)} ${x.where}  ${x.msg}`);
    errors += findings.filter((x) => x.level === 'error').length;
    if (!findings.length) console.log(`ok    ${basename(f)}`);
  }
  if (errors) {
    console.error(`\n${errors} error(s)`);
    process.exit(1);
  }
}
