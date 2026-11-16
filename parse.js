// parse.js — a fast Markdown-to-HTML renderer whose output is byte-identical to
// marked 18.1.3's marked.parse with default options (gfm: true, breaks: false,
// pedantic: false). Dependency-free ES module.
//
// Architecture: a block lexer first walks the document producing a token tree
// (collecting link reference definitions on the way), queueing every chunk of
// inline source; the queued inline chunks are then lexed with a masking pass
// (code spans, links and known reference links are blanked out so emphasis
// delimiter searches cannot see inside them), and the token tree is rendered.
// The lexer mirrors marked's rule set and token decisions exactly; the speed
// comes from first-character dispatch in both lexers, cheap necessary-condition
// pre-checks for the expensive block rules (table, lheading), and a plain-text
// fast path for inline runs that provably lex as a single text token.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeTestRe = /[&<>"']/;
const escapeReplaceRe = /[&<>"']/g;
const escapeTestNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Escape HTML. With encode, every &<>"' is escaped; without, & is left alone
 *  when it already begins a character reference or named entity. */
function escapeHtml(str, encode) {
  if (encode) {
    if (escapeTestRe.test(str)) return str.replace(escapeReplaceRe, (c) => ESCAPE_MAP[c]);
  } else if (escapeTestNoEncodeRe.test(str)) {
    return str.replace(escapeReplaceNoEncodeRe, (c) => ESCAPE_MAP[c]);
  }
  return str;
}

/** marked's cleanUrl: encodeURI, undoing the %25 doubling; null on bad input. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Remove trailing copies of `ch` (marked's rtrim helper). */
function rtrim(str, ch) {
  const len = str.length;
  if (len === 0) return '';
  let suff = 0;
  while (suff < len && str.charAt(len - suff - 1) === ch) suff++;
  return str.slice(0, len - suff);
}

/** Drop trailing blank lines of an indented code / html block, keeping at most
 *  one final newline (marked's tokenizer preprocessing for those blocks). */
function trimBlockEnd(str) {
  const lines = str.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  return lines.length - last <= 2 ? str : lines.slice(0, last + 1).join('\n');
}

/** Expand tabs to spaces with 4-column tab stops, counting from `startColumn`. */
function expandTabs(str, startColumn = 0) {
  let col = startColumn;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/** Link-label normalisation: trim, collapse whitespace, fold case (the double
 *  case conversion handles folds like ß the same way marked does). */
function normalizeLabel(str) {
  return str.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Index of the first unbalanced closing bracket, -1 for none, -2 for unclosed. */
function findClosingBracket(str, brackets) {
  if (str.indexOf(brackets[0]) === -1 && str.indexOf(brackets[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === brackets[0]) level++;
    else if (str[i] === brackets[1] && (level--, level < 0)) return i;
  }
  return level > 0 ? -2 : -1;
}

const numericRefTestRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefReplaceRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Resolve numeric character references in text (marked's unescape step):
 *  invalid code points become U+FFFD, &#38; becomes the literal text &amp;,
 *  and a bare & not starting an entity becomes &amp; as well. */
function decodeCharRefs(str) {
  if (!numericRefTestRe.test(str)) return str;
  return str.replace(numericRefReplaceRe, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

/** Split a table row into cells on unescaped pipes (marked's splitCells). */
function splitCells(str, count) {
  const row = str.replace(/\|/g, (match, offset, full) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && full[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

/** Fenced-code indent compensation: when the fence opener is indented, strip
 *  up to that much leading whitespace from every content line. */
function fenceText(raw, text) {
  const match = raw.match(/^(\s+)(?:```)/);
  if (match === null) return text;
  const indent = match[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = line.match(/^\s+/);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

/** Number of Unicode code points in a (short) string. */
function cpLength(str) {
  let n = 0;
  for (const ch of str) n++;
  return n;
}

/** UTF-16 length of the first code point (1 or 2). */
function firstCpLength(str) {
  const c = str.charCodeAt(0);
  return c >= 0xD800 && c <= 0xDBFF ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Rules (marked's rule set for gfm defaults, as data)
// ---------------------------------------------------------------------------

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
};

const HTML_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Indent-parameterised begin-tests, memoised the way marked memoises them:
// the factory is keyed by clamp(indent - 1, 0, 3) and built from that key.
function indentCached(factory) {
  const store = [];
  return (indent) => {
    const key = Math.max(0, Math.min(3, indent - 1));
    return store[key] || (store[key] = factory(key));
  };
}
const nextBulletRegex = indentCached(
  (n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`),
);
const hrBeginRegex = indentCached(
  (n) => new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
);
const fencesBeginRegex = indentCached((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRegex = indentCached((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = indentCached(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${HTML_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    ),
);
const blockquoteBeginRegex = indentCached((n) => new RegExp(`^ {0,${n}}>`));
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`);

const block = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/,
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))((?:[^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  text: /^[^\n]+/,
};

const inline = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  _backpedal: /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
};

// ---------------------------------------------------------------------------
// Lexer state
// ---------------------------------------------------------------------------

function newLexerState() {
  return {
    links: Object.create(null),
    queue: [], // pending inline chunks: {src, tokens}
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
}

/** Queue inline source for later lexing; returns the (initially empty) token
 *  array that will be filled in place. */
function queueInline(L, src) {
  const tokens = [];
  L.queue.push({ src, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each returns a token or undefined; tokens carry the raw
// source, the inline source text where relevant, and queued inline tokens.
// ---------------------------------------------------------------------------

function fencesToken(cap) {
  return {
    type: 'code',
    raw: cap[0],
    lang: cap[2] ? cap[2].trim().replace(inline.anyPunctuation, '$1') : cap[2],
    text: fenceText(cap[0], cap[3] || ''),
  };
}

function headingToken(L, cap) {
  let text = cap[2].trim();
  if (other.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || other.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
  }
  return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(L, text) };
}

function defToken(cap) {
  if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return undefined;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2]
    ? cap[2].replace(other.hrefBrackets, '$1').replace(inline.anyPunctuation, '$1')
    : '';
  const title = cap[3]
    ? cap[3].substring(1, cap[3].length - 1).replace(inline.anyPunctuation, '$1')
    : cap[3];
  return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}

function tableToken(L, cap) {
  if (!other.tableDelimiter.test(cap[2])) return undefined;
  const headerCells = splitCells(cap[1]);
  const alignCells = cap[2].replace(other.tableAlignChars, '').split('|');
  const rowsText = cap[3]?.trim()
    ? cap[3].replace(other.tableRowBlankLine, '').split('\n')
    : [];
  if (headerCells.length !== alignCells.length) return undefined;
  const token = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of alignCells) {
    token.align.push(
      other.tableAlignRight.test(cell)
        ? 'right'
        : other.tableAlignCenter.test(cell)
          ? 'center'
          : other.tableAlignLeft.test(cell)
            ? 'left'
            : null,
    );
  }
  for (let i = 0; i < headerCells.length; i++) {
    token.header.push({
      text: headerCells[i],
      tokens: queueInline(L, headerCells[i]),
      header: true,
      align: token.align[i],
    });
  }
  for (const rowText of rowsText) {
    token.rows.push(
      splitCells(rowText, token.header.length).map((cell, j) => ({
        text: cell,
        tokens: queueInline(L, cell),
        header: false,
        align: token.align[j],
      })),
    );
  }
  return token;
}

function blockquoteToken(L, src) {
  const cap = block.blockquote.exec(src);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    // Take the next group: lines with a > marker, plus any lazy lines before
    // the first marker line of the following group.
    let hasMarker = false;
    const group = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (other.blockquoteStart.test(lines[p])) {
        group.push(lines[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        group.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const groupRaw = group.join('\n');
    const groupText = groupRaw
      .replace(other.blockquoteMarkerWhitespace, (g, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${groupRaw}` : groupRaw;
    text = text ? `${text}\n${groupText}` : groupText;
    const prevTop = L.top;
    L.top = true;
    blockTokens(L, groupText, tokens, true);
    L.top = prevTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (
      last?.type === 'code' ||
      last?.type === 'heading' ||
      last?.type === 'hr' ||
      last?.type === 'html' ||
      last?.type === 'table'
    ) {
      break;
    }
    if (last?.type === 'blockquote') {
      // The inner quote may extend into the remaining lines: re-lex it whole.
      const rest = lines.join('\n');
      const combined = last.raw + '\n' + rest.replace(other.blockquoteSetextReplace2, '');
      const merged = blockquoteToken(L, combined);
      tokens[tokens.length - 1] = merged;
      const leftover = combined.substring(merged.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - last.text.length) + merged.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
      break;
    }
    if (last?.type === 'list') {
      const combined = last.raw + '\n' + lines.join('\n');
      const merged = listToken(L, combined);
      tokens[tokens.length - 1] = merged;
      const extra =
        merged.raw.length > last.raw.length
          ? combined.slice(last.raw.length + 1, merged.raw.length).split('\n').length
          : 0;
      if (extra > 0) {
        const taken = lines.slice(0, extra).join('\n');
        raw = `${raw}\n${taken}`;
        text = `${text}\n${taken}`;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

function listToken(L, src) {
  const firstCap = block.list.exec(src);
  if (!firstCap) return undefined;
  const fullSrc = src;
  const consumedLen = () => fullSrc.length - src.length;
  let bull = firstCap[1].trim();
  const ordered = bull.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bullPattern = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRe = listItemRegex(bullPattern);
  let prevItemBlank = false;
  let cap = firstCap;
  while (src) {
    let endsBlank = false;
    let itemText = '';
    cap = itemRe.exec(src);
    if (!cap || block.hr.test(src)) break;
    const startIndex = consumedLen();
    src = src.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletLen = cap[1].length;
    const content = firstLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, bulletLen));
    let nextLine = src.split('\n', 1)[0];
    const blankContent = !content.trim();
    let indent = 0;
    if (blankContent) {
      indent = bulletLen + 1;
    } else {
      indent = content.search(other.nonSpaceChar);
      if (indent > 4) indent = 1;
      itemText = content.slice(indent);
      indent += bulletLen;
    }
    if (blankContent && other.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endsBlank = true;
    }
    if (!endsBlank) {
      const nextBullet = nextBulletRegex(indent);
      const hrRe = hrBeginRegex(indent);
      const fencesBegin = fencesBeginRegex(indent);
      const headingBegin = headingBeginRegex(indent);
      const htmlBegin = htmlBeginRegex(indent);
      const quoteBegin = blockquoteBeginRegex(indent);
      let prevLineContent = content;
      let prevBlank = blankContent;
      while (src) {
        const rawLine = src.split('\n', 1)[0];
        const expanded = rawLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws));
        if (
          fencesBegin.test(rawLine) ||
          headingBegin.test(rawLine) ||
          htmlBegin.test(rawLine) ||
          quoteBegin.test(rawLine) ||
          nextBullet.test(rawLine) ||
          hrRe.test(rawLine)
        ) {
          break;
        }
        if (expanded.search(other.nonSpaceChar) >= indent || !rawLine.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          // Lazy continuation line: only while the item's last line is a
          // paragraph-ish line that cannot start a new block itself.
          if (
            prevBlank ||
            prevLineContent.replace(/\t/g, '    ').search(other.nonSpaceChar) >= 4 ||
            fencesBegin.test(prevLineContent) ||
            headingBegin.test(prevLineContent) ||
            htmlBegin.test(prevLineContent) ||
            hrRe.test(prevLineContent)
          ) {
            break;
          }
          const lazyText =
            /^ {0,3}(?:=+|-+) *$/.test(rawLine) && block.lheading.test(prevLineRawForLheading(prevLineContent, rawLine))
              ? '    ' + expanded.replace(/^ {0,3}/, '')
              : rawLine;
          itemText += '\n' + lazyText;
        }
        prevBlank = !rawLine.trim();
        src = src.substring(rawLine.length + 1);
        prevLineContent = expanded.slice(indent);
      }
    }
    const itemRaw = fullSrc.slice(startIndex, consumedLen());
    if (!list.loose) {
      if (prevItemBlank) list.loose = true;
      else if (other.doubleBlankLine.test(itemRaw)) prevItemBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: !!other.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return undefined;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = fullSrc.slice(0, consumedLen()).trimEnd();
  for (const item of list.items) {
    L.top = false;
    item.tokens = blockTokens(L, item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      list.loose = spaces.length > 0 && spaces.some((t) => other.anyLine.test(t.raw));
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      first.raw = first.raw.replace(other.listReplaceTask, '');
      first.text = first.text.replace(other.listReplaceTask, '');
      for (let g = L.queue.length - 1; g >= 0; g--) {
        if (other.listIsTask.test(L.queue[g].src)) {
          L.queue[g].src = L.queue[g].src.replace(other.listReplaceTask, '');
          break;
        }
      }
      const checkboxCap = other.listTaskCheckbox.exec(item.raw);
      if (checkboxCap) {
        const checkbox = { type: 'checkbox', raw: checkboxCap[0] + ' ', checked: checkboxCap[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (
            item.tokens[0] &&
            (item.tokens[0].type === 'paragraph' || item.tokens[0].type === 'text') &&
            'tokens' in item.tokens[0] &&
            item.tokens[0].tokens
          ) {
            item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
            item.tokens[0].text = checkbox.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

// In marked's list loop the setext check is `block.lheading.test(m + '\n' + f)`
// where m is the previous line's content; kept as a tiny helper for clarity.
function prevLineRawForLheading(prevLineContent, rawLine) {
  return prevLineContent + '\n' + rawLine;
}

// ---------------------------------------------------------------------------
// Block lexing driver
// ---------------------------------------------------------------------------

// Cheap necessary-condition checks so the heavy rules only run when they can
// possibly match. Each is a true necessary condition for its rule.
const reSpaceStart = /^[ \t]*(\n|$)/;
const reCodeStart = /^(?: {4}| {0,3}\t)/;
const reFencesStart = /^ {0,3}(?:`{3,}|~{3,})/;
const reHeadingStart = /^ {0,3}#{1,6}(?:\s|$)/;
const reQuoteStart = /^ {0,3}>/;
const reListStart = /^ {0,3}(?:[*+-]|\d{1,9}[.)])/;
const reHtmlStart = /^ {0,3}</;
const reDefStart = /^ {0,3}\[/;
const reSetextLine = /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/;
const reTableDelimLine = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

function blockTokens(L, src, tokens, nested = false) {
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let token;
    let cap;

    // Blank lines / newlines.
    if (reSpaceStart.test(src) && (cap = block.newline.exec(src)) && cap[0].length > 0) {
      src = src.substring(cap[0].length);
      const prev = tokens[tokens.length - 1];
      if (cap[0].length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push({ type: 'space', raw: cap[0] });
      continue;
    }

    // Indented code block; merges into a preceding paragraph/text token.
    if (reCodeStart.test(src) && (cap = block.code.exec(src))) {
      const raw = trimBlockEnd(cap[0]);
      token = { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(other.codeRemoveIndent, '') };
      src = src.substring(raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
        prev.text += '\n' + token.text;
        L.queue[L.queue.length - 1].src = prev.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (reFencesStart.test(src) && (cap = block.fences.exec(src))) {
      src = src.substring(cap[0].length);
      tokens.push(fencesToken(cap));
      continue;
    }

    if (reHeadingStart.test(src) && (cap = block.heading.exec(src))) {
      token = headingToken(L, cap);
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if ((cap = block.hr.exec(src))) {
      token = { type: 'hr', raw: rtrim(cap[0], '\n') };
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (reQuoteStart.test(src) && (token = blockquoteToken(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (reListStart.test(src) && (token = listToken(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (reHtmlStart.test(src) && (cap = block.html.exec(src))) {
      const raw = trimBlockEnd(cap[0]);
      token = {
        type: 'html',
        block: true,
        raw,
        pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
        text: raw,
      };
      src = src.substring(raw.length);
      tokens.push(token);
      continue;
    }

    if (reDefStart.test(src) && (cap = block.def.exec(src)) && (token = defToken(cap))) {
      src = src.substring(token.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
        prev.text += '\n' + token.raw;
        L.queue[L.queue.length - 1].src = prev.text;
      } else {
        if (!Object.hasOwn(L.links, token.tag)) {
          L.links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }

    // Table: needs a delimiter row as the second line.
    const nl = src.indexOf('\n');
    if (nl > 0) {
      const line2End = src.indexOf('\n', nl + 1);
      const line2 = line2End === -1 ? src.slice(nl + 1) : src.slice(nl + 1, line2End);
      if (reTableDelimLine.test(line2) && (cap = block.table.exec(src)) && (token = tableToken(L, cap))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }

    if (reSetextLine.test(src) && (cap = block.lheading.exec(src))) {
      const text = cap[1].trim();
      token = {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: queueInline(L, text),
      };
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (L.top && (cap = block.paragraph.exec(src))) {
      const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
      token = { type: 'paragraph', raw: cap[0], text, tokens: queueInline(L, text) };
      src = src.substring(cap[0].length);
      const prev = tokens[tokens.length - 1];
      if (nested && prev?.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
        prev.text += '\n' + token.text;
        L.queue.pop();
        L.queue[L.queue.length - 1].src = prev.text;
      } else {
        tokens.push(token);
      }
      nested = false;
      continue;
    }

    if ((cap = block.text.exec(src))) {
      token = { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(L, cap[0]) };
      src = src.substring(cap[0].length);
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
        prev.text += '\n' + token.text;
        L.queue.pop();
        L.queue[L.queue.length - 1].src = prev.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  L.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline lexing
// ---------------------------------------------------------------------------

/** True when `text` contains a link or a known reference link (marked's
 *  linkInText, used by the masking pass). */
function linkInText(L, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(inline.blockSkip)) {
    if (inline.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(inline.reflinkSearch)) {
    const s = match[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(L.links, normalizeLabel(s.slice(r + 1, -1)))) &&
      !(r > 1 && linkInText(L, s.slice(1, r - 1)))
    ) {
      return true;
    }
  }
  return false;
}

/** The masking pass: blank out reference links that resolve, escaped
 *  punctuation, code spans and inline link destinations so that emphasis and
 *  strikethrough delimiter searches only see real text. Length-preserving. */
function maskSource(L, src) {
  let masked = src;
  if (masked.includes('[')) {
    const replaceRef = (r) => {
      const open = r.lastIndexOf('[');
      if (!Object.hasOwn(L.links, normalizeLabel(r.slice(open + 1, -1)))) return r;
      if (open > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, open - 1);
        if (linkInText(L, inner)) {
          return '[' + inner.replace(inline.reflinkSearch, replaceRef) + '][' + 'a'.repeat(r.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    masked = masked.replace(inline.reflinkSearch, replaceRef);
  }
  masked = masked.replace(inline.anyPunctuationOutsideCode, (match, codeRun, punct) =>
    punct
      ? '+'.repeat(match.length)
      : codeRun
        ? codeRun + match.slice(codeRun.length, -codeRun.length).replace(/`/g, '+') + codeRun
        : match,
  );
  masked = masked.replace(inline.blockSkip, (match, g1, g2) => {
    const start = g2 ? g2.length : 0;
    return match.slice(0, start) + '[' + 'a'.repeat(match.length - start - 2) + ']';
  });
  return masked;
}

/** Pre-scan a masked source for the last index at which an emphasis or
 *  strikethrough closer can still occur (marked's mask bookkeeping). */
function scanClosers(maskedSrc) {
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  const n = maskedSrc.length;
  for (let s = 0; s < n; s++) {
    const ch = maskedSrc[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : maskedSrc[s - 1];
    let i = s + 1;
    while (i < n && maskedSrc[i] === ch) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = s;
      else lastEm[ch] = s;
    }
    s = i - 1;
  }
  return { maskedSrc, lastEm, lastDel };
}

// Stack of closer scans for nested inline runs (link text, emphasis bodies).
const closerStack = [];

function lastEmCloser(maskedSrc, ch) {
  const top = closerStack[closerStack.length - 1];
  return top && top.maskedSrc === maskedSrc ? top.lastEm[ch] : scanClosers(maskedSrc).lastEm[ch];
}

function lastDelCloser(maskedSrc) {
  const top = closerStack[closerStack.length - 1];
  return top && top.maskedSrc === maskedSrc ? top.lastDel : scanClosers(maskedSrc).lastDel;
}

/** True when the label of a would-be link contains an HTML tag or autolink
 *  that extends past the label's end (marked's check, which rejects it). */
function labelHasLongTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const codeCap = inline.code.exec(label.slice(s));
      if (codeCap) {
        s += codeCap[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const tagCap = inline.tag.exec(rest) || inline.autolink.exec(rest);
    if (tagCap) {
      if (tagCap[0].length > label.length - s) return true;
      s += tagCap[0].length - 1;
    }
  }
  return false;
}

/** Build a link/image token from a link or reference match (marked's
 *  outputLink): lexes the label inline, and rejects the link when a nested
 *  link was emitted inside it. */
function outputLink(L, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const prevInLink = L.inLink;
  const prevEmitted = L.linkEmitted;
  const prevRawBlock = L.inRawBlock;
  L.inLink = true;
  L.linkEmitted = false;
  const tokens = inlineTokens(L, text, []);
  const emitted = L.linkEmitted;
  L.linkEmitted = prevEmitted;
  L.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      L.inRawBlock = prevRawBlock;
      return undefined;
    }
    L.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function linkToken(L, src) {
  if (L.linkParenPossible === false) return undefined;
  const cap = inline.link.exec(src);
  if (!cap) return undefined;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasLongTag(src, cap[1], offset)) return undefined;
  let href = cap[2].trim();
  if (other.startAngleBracket.test(href)) {
    if (!other.endAngleBracket.test(href)) return undefined;
    const trimmed = rtrim(href.slice(0, -1), '\\');
    if ((href.length - trimmed.length) % 2 === 0) return undefined;
  } else {
    const closeIndex = findClosingBracket(cap[2], '()');
    if (closeIndex === -2) return undefined;
    if (closeIndex > -1) {
      const start = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + closeIndex;
      cap[2] = cap[2].substring(0, closeIndex);
      cap[0] = cap[0].substring(0, start).trim();
      cap[3] = '';
    }
  }
  const lastPart = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - lastPart.length) % 2 === 0) return undefined;
  let linkHref = cap[2];
  const linkTitle = cap[3] ? cap[3].slice(1, -1) : '';
  linkHref = linkHref.trim();
  if (other.startAngleBracket.test(linkHref)) {
    linkHref = linkHref.slice(1, -1);
  }
  return outputLink(
    L,
    cap,
    {
      href: linkHref && linkHref.replace(inline.anyPunctuation, '$1'),
      title: linkTitle && linkTitle.replace(inline.anyPunctuation, '$1'),
    },
    cap[0],
  );
}

function reflinkToken(L, src) {
  let cap;
  if ((cap = inline.reflink.exec(src)) || (cap = inline.nolink.exec(src))) {
    const offset = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasLongTag(src, cap[1], offset)) return undefined;
    const link = L.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const firstChar = cap[0].charAt(0);
      return { type: 'text', raw: firstChar, text: firstChar };
    }
    return outputLink(L, cap, link, cap[0]);
  }
  return undefined;
}

function emStrongToken(L, src, maskedSrc, prevChar) {
  let cap = inline.emStrongLDelim.exec(src);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return undefined;
  const delimChar = cap[0][0];
  const prevCharIsDelim = prevChar === delimChar;
  const curPos = maskedSrc.length - src.length;
  let runStart = curPos;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const before = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)];
  const charBefore = before.length ? before[before.length - 1] : '';
  const beforeIsDelimOrPunct =
    charBefore === '*' || charBefore === '_' || !!inline.punctuation.exec(charBefore);
  if (runStart < curPos) prevChar = charBefore;
  const prevIsPunct = runStart < curPos ? beforeIsDelimOrPunct : !!inline.punctuation.exec(prevChar);
  if (cap[4] && prevChar.match(other.unicodeAlphaNumeric)) return undefined;
  const nextChar = cap[1] || cap[3] || '';
  if (!nextChar || !prevChar || prevIsPunct) {
    const delimLen = cpLength(cap[0]) - 1;
    let remaining = delimLen;
    let leftover = 0;
    const totalRun = curPos - runStart + delimLen;
    const canFlip = !!charBefore.trim() && (!!nextChar || (delimChar === '*' && !beforeIsDelimOrPunct));
    if (delimChar !== '*' && delimChar !== '_') return undefined;
    const rDelim = delimChar === '*' ? inline.emStrongRDelimAst : inline.emStrongRDelimUnd;
    const lastCloser = lastEmCloser(maskedSrc, delimChar);
    const startPos = maskedSrc.length - src.length + delimLen;
    if (lastCloser < startPos) return undefined;
    const rest = maskedSrc.slice(maskedSrc.length - src.length + delimLen);
    const limit = lastCloser - startPos;
    rDelim.lastIndex = 0;
    let match;
    while ((match = rDelim.exec(rest)) !== null && !(match.index > limit)) {
      const delim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!delim) continue;
      let delimCount = cpLength(delim);
      if (match[3] || match[4]) {
        remaining += delimCount;
        continue;
      } else if (match[5] || match[6] || canFlip) {
        if (prevCharIsDelim && (match[5] || match[6])) break;
        if (totalRun % 3 && !((totalRun + delimCount) % 3)) {
          leftover += delimCount;
          continue;
        }
      }
      remaining -= delimCount;
      if (remaining > 0) continue;
      delimCount = Math.min(delimCount, delimCount + remaining + leftover);
      const raw = src.slice(0, delimLen + match.index + firstCpLength(match[0]) + delimCount);
      if (Math.min(delimLen, delimCount) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(L, text, []) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(L, text, []) };
    }
  }
  return undefined;
}

function delToken(L, src, maskedSrc, prevChar) {
  const cap = inline.delLDelim.exec(src);
  if (!cap) return undefined;
  if (!(cap[1] || '') || !prevChar || inline.punctuation.exec(prevChar)) {
    const delimLen = cpLength(cap[0]) - 1;
    let remaining = delimLen;
    const lastCloser = lastDelCloser(maskedSrc);
    const startPos = maskedSrc.length - src.length + delimLen;
    if (lastCloser < startPos) return undefined;
    const rest = maskedSrc.slice(maskedSrc.length - src.length + delimLen);
    const limit = lastCloser - startPos;
    inline.delRDelim.lastIndex = 0;
    let match;
    while ((match = inline.delRDelim.exec(rest)) !== null && !(match.index > limit)) {
      const delim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!delim) continue;
      let delimCount = cpLength(delim);
      if (delimCount !== delimLen) continue;
      if (match[3] || match[4]) {
        remaining += delimCount;
        continue;
      }
      remaining -= delimCount;
      if (remaining > 0) continue;
      delimCount = Math.min(delimCount, delimCount + remaining);
      const raw = src.slice(0, delimLen + match.index + firstCpLength(match[0]) + delimCount);
      const text = raw.slice(delimLen, -delimLen);
      return { type: 'del', raw, text, tokens: inlineTokens(L, text, []) };
    }
  }
  return undefined;
}

function autolinkToken(cap) {
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function urlToken(cap) {
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prev;
    do {
      prev = cap[0];
      cap[0] = inline._backpedal.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

// Inline runs with none of these can only ever lex as one plain text token:
// no escapes, tags, brackets, emphasis, code, strikethrough, autolinkable
// addresses/protocols, or hard-break spacing.
const plainTextBlocker = /[\\<!\[`*_~@]| {2,}\n|:\/\/|www\.|mailto:|xmpp:/;

function inlineTokens(L, src, tokens) {
  const prevParenPossible = L.linkParenPossible;
  L.linkParenPossible = prevParenPossible && src.includes(')');
  try {
    let maskedSrc = src;
    if (src.includes('*') || src.includes('_') || src.includes('~')) {
      maskedSrc = maskSource(L, src);
    }
    closerStack.push(scanClosers(maskedSrc));
    try {
      return inlineLoop(L, src, maskedSrc, tokens);
    } finally {
      closerStack.pop();
    }
  } finally {
    L.linkParenPossible = prevParenPossible;
  }
}

function inlineLoop(L, src, maskedSrc, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    let token;
    let cap;
    const c0 = src[0];
    const c1 = src[1];

    if (c0 === '\\' && (cap = inline.escape.exec(src))) {
      src = src.substring(cap[0].length);
      tokens.push({ type: 'escape', raw: cap[0], text: cap[1] });
      continue;
    }

    if (c0 === '<' && (cap = inline.tag.exec(src))) {
      src = src.substring(cap[0].length);
      if (!L.inLink && other.startATag.test(cap[0])) L.inLink = true;
      else if (L.inLink && other.endATag.test(cap[0])) L.inLink = false;
      if (!L.inRawBlock && other.startPreScriptTag.test(cap[0])) L.inRawBlock = true;
      else if (L.inRawBlock && other.endPreScriptTag.test(cap[0])) L.inRawBlock = false;
      tokens.push({ type: 'html', raw: cap[0], inLink: L.inLink, inRawBlock: L.inRawBlock, block: false, text: cap[0] });
      continue;
    }

    if ((c0 === '[' || (c0 === '!' && c1 === '[')) && (token = linkToken(L, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if ((c0 === '[' || (c0 === '!' && c1 === '[')) && (token = reflinkToken(L, src))) {
      src = src.substring(token.raw.length);
      const prev = tokens[tokens.length - 1];
      if (token.type === 'text' && prev?.type === 'text') {
        prev.raw += token.raw;
        prev.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if ((c0 === '*' || c0 === '_') && (token = emStrongToken(L, src, maskedSrc, prevChar))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (c0 === '`' && (cap = inline.code.exec(src))) {
      src = src.substring(cap[0].length);
      let text = cap[2].replace(/\n/g, ' ');
      if (/[^ ]/.test(text) && other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text)) {
        text = text.substring(1, text.length - 1);
      }
      tokens.push({ type: 'codespan', raw: cap[0], text });
      continue;
    }

    if (((c0 === ' ' && c1 === ' ') || (c0 === '\\' && c1 === '\n')) && (cap = inline.br.exec(src))) {
      src = src.substring(cap[0].length);
      tokens.push({ type: 'br', raw: cap[0] });
      continue;
    }

    if (c0 === '~' && (token = delToken(L, src, maskedSrc, prevChar))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (c0 === '<' && (cap = inline.autolink.exec(src))) {
      src = src.substring(cap[0].length);
      tokens.push(autolinkToken(cap));
      continue;
    }

    if (!L.inLink && (cap = inline.url.exec(src)) && (token = urlToken(cap))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // Plain-text fast path: nothing in the rest can start another token.
    if (!plainTextBlocker.test(src)) {
      token = { type: 'text', raw: src, text: L.inRawBlock ? src : decodeCharRefs(src), escaped: L.inRawBlock };
      src = '';
      if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
      keepPrevChar = true;
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'text') {
        prev.raw += token.raw;
        prev.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if ((cap = inline.text.exec(src))) {
      token = {
        type: 'text',
        raw: cap[0],
        text: L.inRawBlock ? cap[0] : decodeCharRefs(cap[0]),
        escaped: L.inRawBlock,
      };
      src = src.substring(cap[0].length);
      if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
      keepPrevChar = true;
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'text') {
        prev.raw += token.raw;
        prev.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderTextToken(token, textOnly) {
  if (textOnly) return token.text;
  if (token.tokens) return renderInline(token.tokens, false);
  return token.escaped ? token.text : escapeHtml(token.text);
}

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCode(token) {
  const langWord = (token.lang || '').match(/^\S*/)?.[0];
  const text = token.text ? token.text.replace(/\n$/, '') + '\n' : '';
  const body = escapeHtml(text, true);
  return langWord
    ? `<pre><code class="language-${escapeHtml(langWord)}">${body}</code></pre>\n`
    : `<pre><code>${body}</code></pre>\n`;
}

function renderTable(token) {
  let headerCells = '';
  for (const cell of token.header) headerCells += renderTableCell(cell);
  let out = '<table>\n<thead>\n' + `<tr>\n${headerCells}</tr>\n` + '</thead>\n';
  let rows = '';
  for (const row of token.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(cell);
    rows += `<tr>\n${cells}</tr>\n`;
  }
  if (rows) out += `<tbody>${rows}</tbody>`;
  return out + '</table>\n';
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens, false) + `</${tag}>\n`;
}

function renderList(list) {
  let body = '';
  for (const item of list.items) body += `<li>${renderBlock(item.tokens)}</li>\n`;
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  return `<${tag}${start}>\n${body}</${tag}>\n`;
}

function renderBlock(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${token.depth}>${renderInline(token.tokens, false)}</h${token.depth}>\n`;
        break;
      case 'code':
        out += renderCode(token);
        break;
      case 'table':
        out += renderTable(token);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderBlock(token.tokens)}</blockquote>\n`;
        break;
      case 'list':
        out += renderList(token);
        break;
      case 'checkbox':
        out += renderCheckbox(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'paragraph':
        out += `<p>${renderInline(token.tokens, false)}</p>\n`;
        break;
      case 'text':
        out += renderTextToken(token, false);
        break;
      default:
        throw new Error(`Token with "${token.type}" type was not found.`);
    }
  }
  return out;
}

function renderLink(token, textOnly) {
  if (textOnly) return token.tokens ? renderInline(token.tokens, true) : token.text;
  const text = token.autolink ? escapeHtml(token.text, true) : renderInline(token.tokens, false);
  const href = cleanUrl(token.href);
  if (href === null) return text;
  let out = `<a href="${escapeHtml(href, token.autolink)}"`;
  if (token.title) out += ` title="${escapeHtml(token.title)}"`;
  return out + `>${text}</a>`;
}

function renderImage(token, textOnly) {
  if (textOnly) return token.tokens ? renderInline(token.tokens, true) : token.text;
  const text = token.tokens ? renderInline(token.tokens, true) : token.text;
  const href = cleanUrl(token.href);
  if (href === null) return escapeHtml(text);
  let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"`;
  if (token.title) out += ` title="${escapeHtml(token.title)}"`;
  return out + '>';
}

function renderInline(tokens, textOnly) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
        out += renderTextToken(token, textOnly);
        break;
      case 'html':
        out += token.text;
        break;
      case 'link':
        out += renderLink(token, textOnly);
        break;
      case 'image':
        out += renderImage(token, textOnly);
        break;
      case 'checkbox':
        out += textOnly ? token.raw : renderCheckbox(token);
        break;
      case 'strong':
        out += textOnly ? renderInline(token.tokens, true) : `<strong>${renderInline(token.tokens, false)}</strong>`;
        break;
      case 'em':
        out += textOnly ? renderInline(token.tokens, true) : `<em>${renderInline(token.tokens, false)}</em>`;
        break;
      case 'codespan':
        out += textOnly ? token.text : `<code>${escapeHtml(token.text, true)}</code>`;
        break;
      case 'br':
        out += textOnly ? '' : '<br>';
        break;
      case 'del':
        out += textOnly ? renderInline(token.tokens, true) : `<del>${renderInline(token.tokens, false)}</del>`;
        break;
      case 'text':
        out += renderTextToken(token, textOnly);
        break;
      default:
        throw new Error(`Token with "${token.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const L = newLexerState();
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const tokens = blockTokens(L, src, []);
  for (let i = 0; i < L.queue.length; i++) {
    const item = L.queue[i];
    L.inRawBlock = false;
    inlineTokens(L, item.src, item.tokens);
  }
  L.queue.length = 0;
  return renderBlock(tokens);
}
