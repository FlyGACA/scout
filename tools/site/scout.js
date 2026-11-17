// Days remaining for the Qoder scheduled tasks. Worked out here, in the reader's
// browser, from each task's expiresAt and today's date, so the number is never
// older than the page view. Nothing is fetched and nothing is stored.
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

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () { apply(new Date()); });
  }
  if (typeof globalThis !== 'undefined') globalThis.ScoutDays = { daysLeft: daysLeft, describe: describe };
})();
