/*
 * The markdown renderer for model output - and the reason it is written by hand.
 *
 * Model output is untrusted text that arrives in the same process as the whole
 * IDE. A markdown library plus an HTML sanitiser plus a `dangerouslySetInnerHTML`
 * equivalent is three chances to render something executable; this renderer
 * escapes every character of the input first and then only ever emits tags from
 * a fixed list it produced itself. There is no path from input text to an
 * arbitrary tag, attribute or URL scheme.
 *
 * The supported subset is what a coding assistant actually emits: fenced and
 * inline code, bold, italic, strikethrough, links, headings, ordered and
 * unordered lists, blockquotes, horizontal rules and paragraphs.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** Only these are allowed to become a clickable link. */
function safeHref(url) {
  const trimmed = String(url).trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  return '';
}

/**
 * Inline spans. Code spans are pulled out first so that markup inside them stays
 * literal - `**not bold**` in a code span has to survive as typed.
 */
export function renderInline(text) {
  const code = [];
  let escaped = escapeHtml(text).replace(/`([^`]+)`/g, (_, inner) => {
    code.push(inner);
    return `\u0000${code.length - 1}\u0000`;
  });

  escaped = escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
      const target = safeHref(href.replace(/&amp;/g, '&'));
      if (!target) return match;
      return `<a href="${escapeHtml(target)}" data-external="1" rel="noreferrer noopener">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return escaped.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${code[Number(index)]}</code>`);
}

function listItem(html, ordered, depth) {
  const marker = ordered ? '' : ' class="bullet"';
  return `<li${marker} data-depth="${depth}">${html}</li>`;
}

/**
 * Block level. One pass with an explicit state machine (fence, list, quote)
 * rather than nested regular expressions, because a fence has to be able to
 * contain anything at all, including lines that look like markup.
 */
export function renderMarkdown(text) {
  const lines = String(text === null || text === undefined ? '' : text).split(/\r\n|\n|\r/);
  const out = [];
  let fence = null;
  let fenceLanguage = '';
  let paragraph = [];
  let list = null;
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fenceMatch) {
      if (fence) {
        out.push(
          `<pre class="code" data-lang="${escapeHtml(fenceLanguage)}"><code>${escapeHtml(fence.join('\n'))}</code></pre>`
        );
        fence = null;
        fenceLanguage = '';
      } else {
        flushAll();
        fence = [];
        fenceLanguage = fenceMatch[2] || '';
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();

    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    const match = bullet || numbered;
    if (match) {
      flushParagraph();
      const depth = Math.min(4, Math.floor(match[1].replace(/\t/g, '  ').length / 2));
      const tag = numbered ? 'ol' : 'ul';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(listItem(renderInline(match[3]), Boolean(numbered), depth));
      continue;
    }
    flushList();
    paragraph.push(line.replace(/\s+$/, ''));
  }

  if (fence) {
    // An unterminated fence still shows its content; model output is cut off
    // mid-stream all the time.
    out.push(
      `<pre class="code" data-lang="${escapeHtml(fenceLanguage)}"><code>${escapeHtml(fence.join('\n'))}</code></pre>`
    );
  }
  flushAll();
  return out.join('\n');
}

/** Plain text for titles, tooltips and the tab strip. */
export function toPlainText(text, limit = 120) {
  const stripped = String(text === null || text === undefined ? '' : text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~>#]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > limit ? `${stripped.slice(0, limit)}…` : stripped;
}