import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintCampaign, norm } from '../tools/ad-copy-lint.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const facts = load('ads/approved-facts.json');
const limits = load('ads/platform-limits.json');
const factsWithPaid = { ...facts, offers: { ...facts.offers, 'pro-test': { what: 'paid', free: false } } };

const url = (src = 'google', camp = 'c-test') =>
  `https://captadel.com/?utm_source=${src}&utm_medium=cpc&utm_campaign=${camp}`;
const base = (variant, extra = {}) => ({
  campaign: 'c-test',
  offer: 'captain-adel-free',
  variants: [
    {
      id: 'v1',
      format: 'google_search_rsa',
      lang: 'en',
      fields: { headline: ['Study GACAR with Captain Adel'], description: ['Not affiliated with GACA.'] },
      url: url(),
      ...variant,
    },
    {
      id: 'v2',
      format: 'google_search_rsa',
      lang: 'ar',
      fields: { headline: ['ذاكر GACAR مع كابتن عادل'], description: ['غير تابعة لـ GACA.'] },
      url: url(),
    },
  ],
  ...extra,
});
const run = (c, f = facts) => lintCampaign(c, { facts: f, limits });
const errors = (c, f) => run(c, f).filter((x) => x.level === 'error').map((x) => x.msg);

test('clean bilingual campaign passes', () => {
  assert.deepEqual(run(base({})), []);
});

test('the committed example passes with only warnings', () => {
  const findings = run(load('ads/copy/captain-adel-free-test.json'));
  assert.deepEqual(findings.filter((x) => x.level === 'error'), []);
});

test('approved disclaimers are not flagged although they say "official" / "رسمي"', () => {
  const c = base({ fields: { headline: ['Study GACAR'], description: [facts.disclaimers.en[0]] } });
  c.variants[1].fields.description = [facts.disclaimers.ar[0]];
  assert.deepEqual(errors(c), []);
});

test('claims of official status, approval or guarantees fail, in both languages', () => {
  for (const h of ['Official GACA Exam Prep', 'GACA approved course', 'Pass guaranteed', '100% pass']) {
    assert.ok(errors(base({ fields: { headline: [h], description: ['Not affiliated with GACA.'] } })).length, h);
  }
  for (const h of ['دورة رسمية', 'محتوى معتمد', 'نجاح مضمون', 'محتوى معتمَد']) {
    const c = base({});
    c.variants[1].fields.headline = [h];
    assert.ok(errors(c).length, h);
  }
});

test('prices fail unless listed in approved-facts', () => {
  assert.ok(errors(base({ fields: { headline: ['Pro for 49 SAR'], description: ['Not affiliated with GACA.'] } }))
    .some((m) => m.includes('price')));
  const c = base({});
  c.variants[1].fields.headline = ['اشترك بـ ٤٩ ريال'];
  assert.ok(errors(c).some((m) => m.includes('price')));
  const ok = { ...facts, prices: [{ display: '49 SAR' }] };
  assert.deepEqual(errors(base({ fields: { headline: ['Pro for 49 SAR'], description: ['Not affiliated with GACA.'] } }), ok), []);
});

test('"free" needs a free offer', () => {
  const c = base({ fields: { headline: ['Start free'], description: ['Not affiliated with GACA.'] } }, { offer: 'pro-test' });
  c.variants[1].fields.headline = ['ابدأ مجانًا'];
  const e = errors(c, factsWithPaid);
  assert.equal(e.filter((m) => m.includes('free')).length, 2);
});

test('length limits', () => {
  const long = 'x'.repeat(31);
  assert.ok(errors(base({ fields: { headline: [long], description: ['Not affiliated with GACA.'] } }))
    .some((m) => m.includes('max 30')));
  const meta = base({ format: 'meta_feed', url: url('facebook'), fields: { primary_text: 'Not affiliated with GACA. ' + 'y'.repeat(120) } });
  const f = run(meta);
  assert.ok(f.some((x) => x.level === 'warn' && x.msg.includes('cut off')));
});

test('disclaimer is required unless the creative or landing page carries it', () => {
  assert.ok(errors(base({ fields: { headline: ['Study GACAR'] } })).some((m) => m.includes('disclaimer')));
  const f = run(base({ fields: { headline: ['Study GACAR'] }, disclaimer_in: 'creative' }));
  assert.deepEqual(f.filter((x) => x.level === 'error'), []);
  assert.ok(f.some((x) => x.level === 'warn' && x.msg.includes('creative')));
  const c = base({});
  c.variants[1].fields.description = ['غير تابع للهيئة العامة للطيران المدني'];
  assert.deepEqual(errors(c), []);
});

test('landing url, domain and UTM tags', () => {
  assert.ok(errors(base({ url: 'http://captadel.com/?utm_source=google&utm_medium=cpc&utm_campaign=c-test' })).some((m) => m.includes('https')));
  assert.ok(errors(base({ url: 'https://evil.example/?utm_source=google&utm_medium=cpc&utm_campaign=c-test' })).some((m) => m.includes('domain')));
  assert.deepEqual(errors(base({ url: 'https://www.flygaca.com/?utm_source=google&utm_medium=cpc&utm_campaign=c-test' })), []);
  assert.ok(errors(base({ url: 'https://captadel.com/' })).some((m) => m.includes('utm_source')));
  assert.ok(errors(base({ url: url('tiktok') })).some((m) => m.includes('does not match')));
  assert.ok(errors(base({ url: url('google', 'other') })).some((m) => m.includes('utm_campaign')));
});

test('unknown offer, unknown format, unknown field, duplicate id', () => {
  assert.ok(errors(base({}, { offer: 'flightbag-pdf' })).some((m) => m.includes('not in ads/approved-facts.json')));
  assert.ok(errors(base({ format: 'myspace' })).some((m) => m.includes('unknown format')));
  assert.ok(errors(base({ fields: { title: 'x', description: ['Not affiliated with GACA.'] } })).some((m) => m.includes('no field')));
  const c = base({});
  c.variants[1].id = 'v1';
  assert.ok(errors(c).some((m) => m.includes('unique id')));
});

test('one language only is a warning', () => {
  const c = base({});
  c.variants.pop();
  assert.ok(run(c).some((x) => x.level === 'warn' && x.msg.includes('one language')));
});

test('norm strips Arabic diacritics and tatweel', () => {
  assert.equal(norm('معتمَد'), 'معتمد');
  assert.equal(norm('لـ  GACA'), 'ل gaca');
});
