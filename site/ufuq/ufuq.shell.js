// Ufuq (أفق) 0.5.0: behaviour for the site shell (ufuq-shell).
// Generated from components/shell.js by `npm run build`. Do not edit by hand.
// Behaviour for the shell component (components/shell.css): the language and
// theme switches, and the name of the signed-in person on a site that sits
// behind Cloudflare Access. Load it in <head> without `defer`, so the page
// opens in the language and theme the reader last chose.
//
//   <button class="ufuq-shell__tool" data-shell-lang>…</button>
//   <button class="ufuq-shell__tool" data-shell-theme>…</button>
//   <span class="ufuq-shell__who" data-shell-who hidden></span>
//   <a class="ufuq-shell__tool" data-shell-out hidden>…</a>
//
// It announces a change with a `ufuq:lang` or `ufuq:theme` event on document.
(() => {
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* private mode: the choice lasts for this page */ }
    },
  };

  function setLang(lang, keep = true) {
    const ar = lang === 'ar';
    root.lang = ar ? 'ar' : 'en';
    root.dir = ar ? 'rtl' : 'ltr';
    if (keep) store.set('ufuq-lang', root.lang);
    for (const el of document.querySelectorAll('[data-label-ar]')) el.setAttribute('aria-label', ar ? el.dataset.labelAr : el.dataset.labelEn);
    document.dispatchEvent(new CustomEvent('ufuq:lang', { detail: root.lang }));
  }

  function setTheme(theme, keep = true) {
    if (theme === 'day') root.dataset.theme = 'day';
    else delete root.dataset.theme;
    if (keep) store.set('ufuq-theme', theme === 'day' ? 'day' : 'dark');
    for (const b of document.querySelectorAll('[data-shell-theme]')) b.setAttribute('aria-pressed', String(theme === 'day'));
    document.dispatchEvent(new CustomEvent('ufuq:theme', { detail: theme === 'day' ? 'day' : 'dark' }));
  }

  // Before anything is painted. The address wins over the remembered choice.
  const lang = params.get('lang') || store.get('ufuq-lang');
  const theme = params.get('theme') || store.get('ufuq-theme');
  if (lang === 'ar' || lang === 'en') { root.lang = lang; root.dir = lang === 'ar' ? 'rtl' : 'ltr'; }
  if (theme === 'day') root.dataset.theme = 'day';

  // Cloudflare Access answers this address with the signed-in identity. Anywhere
  // else (a local preview, a site with no gate) it does not, and nothing shows.
  async function identity() {
    try {
      const res = await fetch('/cdn-cgi/access/get-identity', { credentials: 'same-origin' });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return;
      const { email } = await res.json();
      if (!email) return;
      for (const el of document.querySelectorAll('[data-shell-who]')) { el.textContent = email; el.hidden = false; }
      for (const el of document.querySelectorAll('[data-shell-out]')) { el.href = '/cdn-cgi/access/logout'; el.hidden = false; }
    } catch { /* offline or opened from disk */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    setLang(root.lang === 'ar' ? 'ar' : 'en', false);
    setTheme(root.dataset.theme === 'day' ? 'day' : 'dark', false);
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-shell-lang]')) setLang(root.lang === 'ar' ? 'en' : 'ar');
      else if (event.target.closest('[data-shell-theme]')) setTheme(root.dataset.theme === 'day' ? 'dark' : 'day');
    });
    identity();
  });
})();
