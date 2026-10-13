/** Client-side marked renderer overrides shared by webviews that render model
 *  output. Raw HTML renders as text, links are limited to http(s)/mailto/#,
 *  and remote images become links so nothing loads (and leaks data in its URL)
 *  without a click. The chat view has its own richer renderer with the same rules. */
export function getSafeMarkdownScript(): string {
  return `
    function andromityEscapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    function andromityIsSafeHref(href) {
      return /^(https?:|mailto:|#)/i.test(String(href || '').trim());
    }
    function andromitySafeMarkdownRenderer() {
      return {
        html(token) {
          const raw = token && typeof token === 'object' ? (token.text || token.raw || '') : String(token || '');
          return andromityEscapeHtml(raw);
        },
        link(token) {
          const href = token && typeof token === 'object' ? (token.href || '') : String(token || '');
          const title = token && typeof token === 'object' ? token.title : '';
          const text = token && typeof token === 'object' && token.tokens && this.parser
            ? this.parser.parseInline(token.tokens)
            : andromityEscapeHtml(token && typeof token === 'object' ? (token.text || href) : href);
          if (!andromityIsSafeHref(href)) return text;
          return '<a href="' + andromityEscapeHtml(href) + '" target="_blank" rel="noopener noreferrer"' +
            (title ? ' title="' + andromityEscapeHtml(title) + '"' : '') + '>' + text + '</a>';
        },
        image(token) {
          const href = token && typeof token === 'object' ? (token.href || '') : String(token || '');
          const text = token && typeof token === 'object' ? (token.text || '') : '';
          if (/^data:image\\//i.test(href)) {
            return '<img src="' + andromityEscapeHtml(href) + '" alt="' + andromityEscapeHtml(text) + '" />';
          }
          const label = andromityEscapeHtml(text || href);
          if (/^https?:/i.test(href)) {
            return '<a href="' + andromityEscapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
          }
          return label;
        },
      };
    }
    function andromityUseSafeMarkdown(extraRenderer) {
      if (typeof marked === 'undefined' || !marked.use) return false;
      marked.use({ renderer: Object.assign(andromitySafeMarkdownRenderer(), extraRenderer || {}), gfm: true, breaks: true });
      return true;
    }
  `;
}
