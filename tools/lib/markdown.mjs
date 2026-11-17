// A small Markdown renderer for the ads playbook. No dependencies, no network.
// It handles what ads/PLAYBOOK.md uses: headings, paragraphs, lists (nested, with tables
// inside items), tables, block quotes, bold, italic, code and links.
//
// Two safety properties the site relies on:
//   - everything is escaped; the source cannot inject markup;
//   - a link to a repository file is not a link on the site (the file is not published),
//     so it is shown as code; only http(s) links stay links.
// `withhold(text)` lets the caller drop a passage (a paragraph, a list item or a table row);
// the site uses it to keep the owner's approved facts out of site/.

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function slug(text) {
  const s = String(text)
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return s || 'section';
}

export function plainInline(s) {
  return String(s).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

export function inline(src) {
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const u = url.replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(u)) return `<a href="${esc(u)}" rel="noopener noreferrer">${label}</a>`;
    return `<code class="mono ltr">${label.replace(/\u0000(\d+)\u0000/g, (m, i) => esc(codes[+i]))}</code>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="mono ltr">${esc(codes[+i])}</code>`);
}

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isRule = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

export function renderMarkdown(md, { withhold = () => false, placeholder = '[withheld]', tableLabel = () => '' } = {}) {
  const toc = [];
  const used = new Map();
  let withheld = 0;
  const hold = () => {
    withheld++;
    return placeholder;
  };

  function blocks(lines, nested) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h && !nested) {
        const level = h[1].length;
        const text = plainInline(h[2]);
        let id = slug(text);
        const n = used.get(id) || 0;
        used.set(id, n + 1);
        if (n) id += `-${n + 1}`;
        if (level >= 2) toc.push({ level, id, text });
        out.push({ type: 'h', html: `<h${level} id="${id}">${inline(h[2])} <a class="anchor" href="#${id}" aria-label="Link to this section: ${esc(text)}">#</a></h${level}>` });
        i++;
        continue;
      }
      if (/^\s*---+\s*$/.test(line)) { out.push({ type: 'hr', html: '<hr>' }); i++; continue; }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
        const head = cellsOf(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cellsOf(lines[i++]));
        const body = rows
          .map((r) => (withhold(r.join(' ')) ? `<tr><td colspan="${head.length}">${hold()}</td></tr>` : `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`))
          .join('\n');
        const label = tableLabel(head);
        out.push({ type: 'table', html: `<div class="ufuq-table-wrap table-wrap" tabindex="0" role="region" aria-label="${esc(label)}"><table class="ufuq-table"><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>\n${body}\n</tbody></table></div>\n<p class="scroll-hint"><span class="ufuq-en">Scroll the table sideways to see every column.</span><span class="ufuq-ar" lang="ar">مرّر الجدول جانبيًا لرؤية كل الأعمدة.</span></p>` });
        continue;
      }
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        const text = q.join(' ');
        out.push({ type: 'quote', html: `<blockquote>${withhold(text) ? hold() : inline(text)}</blockquote>` });
        continue;
      }
      const li = LIST.exec(line);
      if (li) {
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = LIST.exec(lines[i]);
          if (!m || m[1].length > li[1].length) break;
          if (m[1].length < li[1].length) break;
          const body = [m[3]];
          const width = m[1].length + m[2].length + 1;
          i++;
          while (i < lines.length) {
            const l = lines[i];
            if (!l.trim()) {
              if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !(LIST.exec(lines[i + 1]) && LIST.exec(lines[i + 1])[1].length <= m[1].length)) { body.push(''); i++; continue; }
              break;
            }
            if (LIST.exec(l) && LIST.exec(l)[1].length <= m[1].length) break;
            if (!/^\s/.test(l)) break;
            body.push(l.slice(Math.min(width, l.length - l.trimStart().length)));
            i++;
          }
          items.push(body);
        }
        const tag = ordered ? 'ol' : 'ul';
        const html = items
          .map((b) => {
            const inner = blocks(b, true);
            const first = inner[0];
            const parts = inner.map((x, k) => (k === 0 && x.type === 'p' ? x.inner : x.html));
            return `<li>${parts.join('\n')}</li>`;
          })
          .join('\n');
        out.push({ type: 'list', html: `<${tag}>\n${html}\n</${tag}>` });
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*>|\s*\|)/.test(lines[i]) && !LIST.exec(lines[i])) para.push(lines[i++].trim());
      if (!para.length) { para.push(lines[i++]); }
      const text = para.join(' ');
      const inner = withhold(text) ? hold() : inline(text);
      out.push({ type: 'p', inner, html: `<p>${inner}</p>` });
    }
    return out;
  }

  const out = blocks(String(md).split(/\r?\n/), false);
  return { html: out.map((b) => b.html).join('\n'), toc, withheld };
}
