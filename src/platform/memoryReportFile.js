'use strict';

// The weekly memory report (docs/EXTENSION_CONTRACT.md, hooks.weeklyMemoryReport): the one HTML file an extension
// may upload, and only from that hook, to the direct-message channel the hook has just opened with the bot owner
// (src/platform/egressGuard.js). This module holds what that exception admits: the hook, the file name, the size,
// the content type and the shape of the HTML itself. The HTML is inert: a fixed set of tags with fixed attributes,
// no script, no event handler, no link or other address, no comment, and a Content-Security-Policy that forbids
// scripts and every request in a browser that opens it. Anything else is refused whole, so a report whose text was
// not escaped is never sent.

const MEMORY_REPORT_HOOK = 'weeklyMemoryReport';
const MEMORY_REPORT_HOOK_NAME = `hooks.${MEMORY_REPORT_HOOK}`;
// Capture group 1 is the file kind, as egressGuard's file rules read it.
const MEMORY_REPORT_FILE_NAME = /^xiaoji-memory-report-[0-9]{8}\.(html)$/u;
const MEMORY_REPORT_MAX_BYTES = 8 * 1024 * 1024;
const MEMORY_REPORT_CONTENT_TYPE = 'text/html; charset=utf-8';
const MEMORY_REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'";
// The report runs every 168 hours from the start of the bot.
const MEMORY_REPORT_INTERVAL_MS = 168 * 60 * 60 * 1000;

const TAGS = new Set([
  'html', 'head', 'title', 'style', 'body', 'header', 'main', 'section', 'footer', 'h1', 'h2', 'h3', 'p', 'ul',
  'li', 'span', 'small', 'strong', 'div', 'details', 'summary',
]);
const VOID_TAGS = new Set(['meta', 'br']);
// The only <meta> elements: exactly these, written exactly so.
const META_TAGS = new Set([
  '<meta charset="utf-8">',
  `<meta http-equiv="Content-Security-Policy" content="${MEMORY_REPORT_CSP}">`,
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
]);
const CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="${MEMORY_REPORT_CSP}">`;
const DOCTYPE = '<!doctype html>';
// A start or end tag in lower case with at most a lang (on <html>) and a class of plain words. Anything else that
// starts with "<" (a comment, a CDATA section, an upper-case or unknown tag, an attribute such as onclick or href)
// does not match.
const TAG = /<(\/?)([a-z][a-z0-9]*)((?: (?:class="[a-z0-9 _-]{0,80}"|lang="zh-Hant"))*)>/uy;
// Style sheets may not load or run anything: no url(), no @import, no escape, no expression(), no markup.
const UNSAFE_STYLE = /url\s*\(|@import|\\|expression\s*\(|<|javascript|behavior|-moz-binding/iu;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"'=`]/gu, (character) => `&#${character.codePointAt(0)};`);
}

// True when text is a report this exception may carry: it starts with the doctype, holds the CSP meta tag once in
// <head>, and every "<" in it opens an admitted tag.
function isInertReportHtml(text) {
  if (typeof text !== 'string' || !text.startsWith(DOCTYPE)) return false;
  const head = text.indexOf('<head>');
  const csp = text.indexOf(CSP_TAG);
  const headEnd = text.indexOf('</head>');
  if (head < 0 || csp < head || headEnd < csp || text.indexOf(CSP_TAG, csp + 1) >= 0) return false;
  let index = DOCTYPE.length;
  const stack = [];
  while (index < text.length) {
    const next = text.indexOf('<', index);
    if (next < 0) break;
    if (text.startsWith('<meta ', next)) {
      const end = text.indexOf('>', next);
      if (end < 0 || !META_TAGS.has(text.slice(next, end + 1)) || stack.at(-1) !== 'head') return false;
      index = end + 1;
      continue;
    }
    if (text.startsWith('<br>', next)) {
      index = next + 4;
      continue;
    }
    TAG.lastIndex = next;
    const match = TAG.exec(text);
    if (!match) return false;
    const [whole, closing, name, attributes] = match;
    if (!TAGS.has(name) || VOID_TAGS.has(name)) return false;
    if (attributes.includes('lang=') && name !== 'html') return false;
    index = next + whole.length;
    if (closing) {
      if (attributes || stack.pop() !== name) return false;
      continue;
    }
    if (name === 'style') {
      const end = text.indexOf('</style>', index);
      if (end < 0 || attributes || stack.at(-1) !== 'head' || UNSAFE_STYLE.test(text.slice(index, end))) return false;
      index = end + '</style>'.length;
      continue;
    }
    stack.push(name);
  }
  return stack.length === 0;
}

module.exports = {
  MEMORY_REPORT_CONTENT_TYPE,
  MEMORY_REPORT_CSP,
  MEMORY_REPORT_FILE_NAME,
  MEMORY_REPORT_HOOK,
  MEMORY_REPORT_HOOK_NAME,
  MEMORY_REPORT_INTERVAL_MS,
  MEMORY_REPORT_MAX_BYTES,
  escapeHtml,
  isInertReportHtml,
};
