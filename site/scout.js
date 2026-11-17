// Behaviour for the Scout site. Nothing is fetched and nothing is stored.
//   - days remaining for the Qoder scheduled tasks, worked out here from each task's
//     expiresAt and today's date, so the number is never older than the page view;
//   - search and filters for the tables that have a filter bar;
//   - copy buttons for the commands;
//   - the ad-copy self-check (a subset of tools/ad-copy-lint.mjs).
(function () {
  'use strict';
  var WARN_DAYS = 14;

  // expiresAt is a calendar date (YYYY-MM-DD). Compare it with the reader's own calendar date.
  function daysLeft(expiresAt, now) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(expiresAt));
    if (!m) return null;
    var end = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((end - today) / 86400000);
  }

  function arDays(n) {
    if (n === 1) return 'يوم واحد';
    if (n === 2) return 'يومان';
    if (n >= 3 && n <= 10) return n + ' أيام';
    return n + ' يومًا';
  }

  function describe(n) {
    if (n === null) return { en: 'date not readable', ar: 'التاريخ غير مقروء', tone: 'neutral', state: 'unknown', stateEn: 'Check the date', stateAr: 'تحقق من التاريخ' };
    if (n < 0) {
      var ago = -n;
      return { en: 'expired ' + ago + (ago === 1 ? ' day' : ' days') + ' ago', ar: 'انتهت منذ ' + arDays(ago), tone: 'danger', stateEn: 'Expired', stateAr: 'منتهية' };
    }
    if (n === 0) return { en: 'expires today', ar: 'تنتهي اليوم', tone: 'warning', stateEn: 'Expires soon', stateAr: 'تنتهي قريبًا' };
    var soon = n < WARN_DAYS;
    return {
      en: n + (n === 1 ? ' day left' : ' days left'),
      ar: 'تبقى ' + arDays(n),
      tone: soon ? 'warning' : 'success',
      stateEn: soon ? 'Expires soon' : 'More than 14 days remain',
      stateAr: soon ? 'تنتهي قريبًا' : 'أكثر من 14 يومًا متبقية',
    };
  }

  function setPair(el, en, ar) {
    var e = el.querySelector('.ufuq-en'), a = el.querySelector('.ufuq-ar');
    if (e) e.textContent = en;
    if (a) a.textContent = ar;
  }

  function apply(now) {
    var expiring = document.querySelectorAll('[data-expires]');
    for (var i = 0; i < expiring.length; i++) {
      var el = expiring[i];
      var d = describe(daysLeft(el.getAttribute('data-expires'), now));
      setPair(el, d.en, d.ar);
    }
    var badges = document.querySelectorAll('[data-expires-badge]');
    for (var j = 0; j < badges.length; j++) {
      var b = badges[j];
      var s = describe(daysLeft(b.getAttribute('data-expires-badge'), now));
      b.className = 'ufuq-badge ufuq-badge--' + s.tone;
      setPair(b, s.stateEn, s.stateAr);
    }
  }

  /* ---------------------------------------------------------------- table filters */

  // rows: [{ text, attrs: {key: value} }]; q: search text; sel: {key: value}. Returns a visibility flag per row.
  function filterRows(rows, q, sel) {
    var needle = String(q || '').trim().toLowerCase();
    return rows.map(function (r) {
      if (needle && r.text.toLowerCase().indexOf(needle) === -1) return false;
      for (var k in sel) if (sel[k] && r.attrs[k] !== sel[k]) return false;
      return true;
    });
  }

  function initFilter(bar) {
    var table = document.getElementById(bar.getAttribute('data-filter-for'));
    if (!table) return;
    var q = bar.querySelector('[data-filter-q]');
    var selects = bar.querySelectorAll('[data-filter-key]');
    var count = bar.querySelector('[data-filter-count]');
    var empty = table.querySelector('.empty-row');
    var trs = Array.prototype.slice.call(table.querySelectorAll('tbody tr')).filter(function (t) { return t !== empty; });
    var rows = trs.map(function (tr) {
      var attrs = {};
      for (var i = 0; i < selects.length; i++) {
        var key = selects[i].getAttribute('data-filter-key');
        attrs[key] = tr.getAttribute('data-f-' + key);
      }
      return { text: tr.textContent, attrs: attrs };
    });
    function run() {
      var sel = {};
      for (var i = 0; i < selects.length; i++) sel[selects[i].getAttribute('data-filter-key')] = selects[i].value;
      var vis = filterRows(rows, q.value, sel);
      var n = 0;
      for (var j = 0; j < trs.length; j++) {
        trs[j].hidden = !vis[j];
        if (vis[j]) n++;
      }
      if (empty) empty.hidden = n !== 0;
      if (count) {
        var en = n + ' of ' + trs.length + ' rows shown';
        var ar = 'يظهر ' + n + ' من ' + trs.length + ' صفًا';
        count.innerHTML = '<span class="ufuq-en"></span><span class="ufuq-ar" lang="ar"></span>';
        setPair(count, en, ar);
      }
    }
    q.addEventListener('input', run);
    for (var i = 0; i < selects.length; i++) selects[i].addEventListener('change', run);
    bar.hidden = false;
    run();
  }

  /* ---------------------------------------------------------------- copy buttons */

  function copyText(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'ufuq-sr-only';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function initCopy(btn) {
    var status = btn.parentNode.querySelector('.copy-status');
    function say(en, ar) {
      if (!status) return;
      status.innerHTML = '<span class="ufuq-en"></span><span class="ufuq-ar" lang="ar"></span>';
      setPair(status, en, ar);
      setTimeout(function () { status.textContent = ''; }, 2500);
    }
    btn.addEventListener('click', function () {
      copyText(btn.getAttribute('data-copy')).then(
        function () { say('Copied', 'تم النسخ'); },
        function () { say('Could not copy: select the command and copy it by hand', 'تعذّر النسخ: حدّد الأمر وانسخه يدويًا'); }
      );
    });
    btn.hidden = false;
  }

  /* ---------------------------------------------------------------- ad-copy self-check */

  // The same normalisation as norm() in tools/ad-copy-lint.mjs (a test keeps them equal).
  function norm(s) {
    return String(s)
      .normalize('NFC')
      .replace(/[ً-ٰٟـ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function lenOf(t) {
    return Array.from(String(t).trim()).length;
  }

  // cfg: the data embedded in copycheck.html. input: { format, field, lang, text, elsewhere }.
  // Returns findings: { level: 'error' | 'warn', en, ar }.
  function checkCopy(cfg, input) {
    var out = [];
    var fmt = null;
    for (var i = 0; i < cfg.formats.length; i++) if (cfg.formats[i].id === input.format) fmt = cfg.formats[i];
    var rule = null;
    if (fmt) for (var j = 0; j < fmt.fields.length; j++) if (fmt.fields[j].field === input.field) rule = fmt.fields[j];
    var lines = String(input.text || '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return out;
    var tagEn = fmt && !fmt.verified ? ' (limit not yet verified)' : '';
    var tagAr = fmt && !fmt.verified ? ' (الحد غير موثّق بعد)' : '';
    lines.forEach(function (l, k) {
      var n = lenOf(l);
      var at = lines.length > 1 ? 'line ' + (k + 1) + ': ' : '';
      var atAr = lines.length > 1 ? 'السطر ' + (k + 1) + ': ' : '';
      if (rule && rule.max && n > rule.max) out.push({ level: 'error', en: at + n + ' characters, max ' + rule.max + tagEn, ar: atAr + n + ' حرفًا، الحد الأقصى ' + rule.max + tagAr });
      else if (rule && rule.recommended && n > rule.recommended) out.push({ level: 'warn', en: at + n + ' characters, gets cut off after ' + rule.recommended + tagEn, ar: atAr + n + ' حرفًا، يُقطع بعد ' + rule.recommended + tagAr });
    });
    var scan = norm(lines.join(' \n '));
    [cfg.notice.en, cfg.notice.ar].forEach(function (d) { scan = scan.split(norm(d)).join(' '); });
    cfg.banned.forEach(function (b) {
      var m = scan.match(new RegExp(b.source, b.flags.replace('g', '')));
      if (m) out.push({ level: 'error', en: '"' + m[0] + '" ' + b.why, ar: '«' + m[0] + '» ' + b.why });
    });
    var prices = scan.match(new RegExp(cfg.price.source, cfg.price.flags.indexOf('g') === -1 ? cfg.price.flags + 'g' : cfg.price.flags)) || [];
    prices.forEach(function (m) {
      out.push({ level: 'warn', en: 'looks like a price: "' + m.trim() + '". The checker accepts only prices the owner has approved; this page cannot check that', ar: 'يشبه سعرًا: «' + m.trim() + '». لا يقبل الفاحص إلا الأسعار التي اعتمدها المالك، ولا تستطيع هذه الصفحة التحقق من ذلك' });
    });
    if (new RegExp(cfg.free.source, cfg.free.flags.replace('g', '')).test(scan)) {
      out.push({ level: 'warn', en: 'says free: the checker accepts this only when the offer is marked free by the owner', ar: 'يذكر «مجاني»: لا يقبل الفاحص ذلك إلا إذا وسم المالك العرض بأنه مجاني' });
    }
    var marker = cfg.marker[input.lang];
    if (marker && !new RegExp(marker).test(norm(lines.join(' ')))) {
      if (input.elsewhere) out.push({ level: 'warn', en: 'no disclaimer in the text; check it is visible in the creative or the landing page', ar: 'لا توجد عبارة تحذيرية في النص؛ تأكد من ظهورها في التصميم أو الصفحة المقصودة' });
      else out.push({ level: 'error', en: 'no "not affiliated with GACA" disclaimer in the text (tick the box if the creative or landing page carries it)', ar: 'لا توجد عبارة «غير تابعة لـ GACA» في النص (علّم المربع إذا كان التصميم أو الصفحة المقصودة تحملها)' });
    }
    return out;
  }

  function initCopyCheck() {
    var form = document.getElementById('cc');
    var dataEl = document.getElementById('cc-data');
    if (!form || !dataEl) return;
    var cfg = JSON.parse(dataEl.textContent);
    var fmtSel = document.getElementById('cc-format');
    var fieldSel = document.getElementById('cc-field');
    var langSel = document.getElementById('cc-lang');
    var text = document.getElementById('cc-text');
    var elsewhere = document.getElementById('cc-elsewhere');
    var result = document.getElementById('cc-result');
    function fillFields() {
      var fmt = cfg.formats.filter(function (f) { return f.id === fmtSel.value; })[0];
      fieldSel.innerHTML = '';
      (fmt ? fmt.fields : []).forEach(function (f) {
        var o = document.createElement('option');
        var lim = [f.max ? 'max ' + f.max : '', f.recommended ? 'recommended ' + f.recommended : ''].filter(Boolean).join(', ');
        o.value = f.field;
        o.textContent = f.field + (lim ? ' (' + lim + ')' : '');
        fieldSel.appendChild(o);
      });
    }
    function add(parent, tag, cls, html) {
      var el = document.createElement(tag);
      if (cls) el.className = cls;
      if (html != null) el.innerHTML = html;
      parent.appendChild(el);
      return el;
    }
    function run() {
      var findings = checkCopy(cfg, { format: fmtSel.value, field: fieldSel.value, lang: langSel.value, text: text.value, elsewhere: elsewhere.checked });
      result.innerHTML = '';
      var lines = text.value.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) {
        var p = add(result, 'p', 'panel-note', '<span class="ufuq-en"></span><span class="ufuq-ar" lang="ar"></span>');
        setPair(p, 'Paste some text to see the result.', 'الصق نصًا لترى النتيجة.');
        return;
      }
      var errors = findings.filter(function (f) { return f.level === 'error'; }).length;
      var warns = findings.length - errors;
      var tone = errors ? 'danger' : warns ? 'warning' : 'success';
      var sum = add(result, 'p', '', '<span class="ufuq-badge ufuq-badge--' + tone + '"><span class="ufuq-en"></span><span class="ufuq-ar" lang="ar"></span></span> <span class="ufuq-en"></span><span class="ufuq-ar" lang="ar"></span>');
      var badge = sum.querySelector('.ufuq-badge');
      setPair(badge, errors ? 'Errors' : warns ? 'Warnings only' : 'No problems found', errors ? 'أخطاء' : warns ? 'تحذيرات فقط' : 'لا مشكلات');
      var spans = sum.querySelectorAll(':scope > .ufuq-en, :scope > .ufuq-ar');
      spans[0].textContent = errors + ' error(s), ' + warns + ' warning(s) from this subset of the checker. Run node tools/ad-copy-lint.mjs for the full check.';
      spans[1].textContent = errors + ' أخطاء و' + warns + ' تحذيرات من هذا الجزء من الفاحص. شغّل node tools/ad-copy-lint.mjs للفحص الكامل.';
      var counts = add(result, 'p', 'panel-note', '<span class="ufuq-en"></span><span class="ufuq-ar" lang="ar"></span>');
      setPair(counts, 'Length per line: ' + lines.map(lenOf).join(', '), 'الطول لكل سطر: ' + lines.map(lenOf).join('، '));
      if (findings.length) {
        var ul = add(result, 'ul', 'checklist');
        findings.forEach(function (f) {
          var li = add(ul, 'li', '', '<span class="ufuq-badge ufuq-badge--' + (f.level === 'error' ? 'danger' : 'warning') + '"><span class="ufuq-en"></span><span class="ufuq-ar" lang="ar"></span></span> <span class="ufuq-en"></span><span class="ufuq-ar" lang="ar"></span>');
          setPair(li.querySelector('.ufuq-badge'), f.level === 'error' ? 'Error' : 'Warning', f.level === 'error' ? 'خطأ' : 'تحذير');
          var sp = li.querySelectorAll(':scope > .ufuq-en, :scope > .ufuq-ar');
          sp[0].textContent = f.en;
          sp[1].textContent = f.ar;
        });
      }
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    fillFields();
    fmtSel.addEventListener('change', function () { fillFields(); run(); });
    [fieldSel, langSel, elsewhere].forEach(function (el) { el.addEventListener('change', run); });
    text.addEventListener('input', run);
    form.hidden = false;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      apply(new Date());
      var bars = document.querySelectorAll('[data-filter-for]');
      for (var i = 0; i < bars.length; i++) initFilter(bars[i]);
      var btns = document.querySelectorAll('[data-copy]');
      for (var j = 0; j < btns.length; j++) initCopy(btns[j]);
      initCopyCheck();
    });
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.ScoutDays = { daysLeft: daysLeft, describe: describe };
    globalThis.ScoutTools = { filterRows: filterRows, norm: norm, checkCopy: checkCopy };
  }
})();
