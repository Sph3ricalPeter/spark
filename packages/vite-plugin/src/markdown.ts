// A small Markdown renderer for Claude's replies (the Ask chat, the panel's
// run summary): paragraphs, headings, bullet and numbered lists, code blocks,
// quotes, and inline bold, italic, code and links.
//
// It builds DOM nodes and sets only text, never innerHTML, so whatever Claude
// writes can't inject markup into Spark.

type Inline = Node | string;

/** **bold**, *italic* / _italic_, `code`, [text](url). */
function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[2] !== undefined) {
      const c = document.createElement("code");
      c.textContent = m[2].trim();
      out.push(c);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const b = document.createElement("strong");
      b.append(...inline(m[3] ?? m[4]));
      out.push(b);
    } else if (m[5] !== undefined || m[6] !== undefined) {
      const i = document.createElement("em");
      i.append(...inline(m[5] ?? m[6]));
      out.push(i);
    } else if (m[7] !== undefined) {
      const url = m[8];
      if (/^https?:\/\//i.test(url)) {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.append(...inline(m[7]));
        out.push(a);
      } else out.push(...inline(m[7]));
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)(\d+)[.)]\s+(.*)$/;

/** Markdown as a fragment of elements, styled by the `.md` rules (MARKDOWN_STYLE). */
export function markdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // ``` code block
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = body.join("\n");
      pre.append(code);
      frag.append(pre);
      continue;
    }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      const el = document.createElement("div");
      el.className = `md-h md-h${head[1].length}`;
      el.append(...inline(head[2]));
      frag.append(el);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      const q = document.createElement("blockquote");
      q.append(markdown(body.join("\n")));
      frag.append(q);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      frag.append(document.createElement("hr"));
      i++;
      continue;
    }
    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = !BULLET.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      const first = line.match(NUMBER);
      if (ordered && first && first[2] !== "1") list.setAttribute("start", first[2]);
      let item: HTMLElement | null = null;
      while (i < lines.length) {
        const l = lines[i];
        const m = ordered ? l.match(NUMBER) : l.match(BULLET);
        if (m && m[1].length < 2) {
          item = document.createElement("li");
          item.append(...inline(ordered ? m[3] : m[2]));
          list.append(item);
          i++;
        } else if (item && l.trim() && (/^\s{2,}/.test(l) || (!BULLET.test(l) && !NUMBER.test(l) && !/^\s*(#|```|>)/.test(l)))) {
          // A wrapped or nested line belongs to the item above.
          const nested = l.trim().match(/^([-*+]|\d+[.)])\s+(.*)$/);
          if (nested) {
            const sub = document.createElement("div");
            sub.className = "md-sub";
            sub.append(...inline(nested[2]));
            item.append(sub);
          } else item.append(" ", ...inline(l.trim()));
          i++;
        } else break;
      }
      frag.append(list);
      continue;
    }
    // A paragraph: lines up to a blank line or another block.
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBER.test(lines[i])) body.push(lines[i++].trim());
    const p = document.createElement("p");
    body.forEach((b, k) => {
      if (k) p.append(document.createElement("br"));
      p.append(...inline(b));
    });
    frag.append(p);
  }
  return frag;
}

/** How rendered Markdown looks in Spark's UI (inside a `.md` container). */
export const MARKDOWN_STYLE = `
    .md { white-space: normal; overflow-wrap: anywhere; font-feature-settings: "liga" 0, "calt" 0; }
    .md > :first-child { margin-top: 0; }
    .md > :last-child { margin-bottom: 0; }
    .md p { margin: 0 0 8px; }
    .md ul, .md ol { margin: 0 0 8px; padding-left: 18px; }
    .md li { margin: 2px 0; }
    .md li::marker { color: var(--sp-text-dim); }
    .md .md-sub { position: relative; margin-top: 2px; padding-left: 12px; }
    .md .md-sub::before { content: "–"; position: absolute; left: 0; color: var(--sp-text-dim); }
    .md strong { color: var(--sp-text-strong); font-weight: 600; }
    .md em { font-style: italic; }
    .md code {
      padding: 1px 4px; border-radius: var(--sp-r-sm); background: var(--sp-field); color: var(--sp-text-strong);
      font: 0.92em var(--sp-mono);
    }
    .md pre {
      margin: 0 0 8px; padding: 6px 8px; border-radius: var(--sp-r-md); background: var(--sp-bg); border: 1px solid var(--sp-line);
      overflow-x: auto; white-space: pre;
    }
    .md pre code { padding: 0; background: none; font-size: var(--sp-fs-sm); }
    .md .md-h { margin: 10px 0 4px; color: var(--sp-text-strong); font-weight: 700; }
    .md .md-h1, .md .md-h2 { font-size: var(--sp-fs-lg); }
    .md blockquote { margin: 0 0 8px; padding-left: 8px; border-left: 2px solid var(--sp-line-strong); color: var(--sp-text-dim); }
    .md hr { border: none; border-top: 1px solid var(--sp-line); margin: 8px 0; }
    .md a { color: var(--sp-link); }
`;
