// A fast Markdown renderer that produces, for every input string, exactly the
// HTML that marked 18.1.3 produces with its default options (GFM enabled,
// line breaks off, pedantic off). Written from scratch as a single
// dependency-free ES module: a block phase that splits the document into
// block tokens (collecting link definitions and queueing inline work), an
// inline phase that runs once every definition is known, and a renderer
// that walks the token tree emitting HTML strings.
//
// The grammar patterns below mirror the reference grammar rule for rule,
// because the required output is defined by that grammar's exact behaviour,
// including its quirks. The parsing machinery around them (first-character
// dispatch in both phases, cheap necessary-condition scans before the
// expensive patterns, a hand-rolled paragraph extent scan, masking that is
// skipped when it would be the identity, and a plain-text fast path for
// inline runs with no triggers) is what makes it fast.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

// Remove a run of one repeated character from the end of a string.
function stripTrailing(str, ch) {
  let end = str.length;
  while (end > 0 && str.charAt(end - 1) === ch) end--;
  return str.slice(0, end);
}

// Drop trailing blank lines, but only when there are at least two of them:
// a single trailing blank line (or none) is kept as written.
function dropTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// Expand tab characters to the next multiple-of-4 column, counting the
// given starting column (used for list and blockquote indentation maths).
function expandTabs(line, indent = 0) {
  if (!line.includes('\t')) return line;
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// The key a link label is stored and looked up under: trimmed, internal
// whitespace collapsed to single spaces, then case-folded (through upper
// case so folds like ß -> ss work, matching commonmark.js).
function labelKey(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find where a bracket pair closes, honouring backslash escapes.
// Returns the index of the closer that takes the level below zero, -2 when
// the string ends with unclosed openers, and -1 when balanced or absent.
function closingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === pair[0]) {
      level++;
    } else if (str[i] === pair[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Split a table row into its cells: pipes that are not backslash-escaped
// delimit cells, a leading or trailing pipe does not make an empty cell,
// and the row is padded or truncated to `count` cells when given.
function splitRow(row, count) {
  const spaced = row.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// ---------------------------------------------------------------------------
// HTML escaping, URL cleaning, numeric character references
// ---------------------------------------------------------------------------

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_ALL_TEST = /[&<>"']/;
const ESCAPE_ALL_RE = /[&<>"']/g;
const ESCAPE_LOOSE_TEST = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_LOOSE_RE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape the five HTML-significant characters. With `encode` set, every
// ampersand is escaped; without it, an ampersand that already begins a
// character reference (named, decimal or hex) is left alone.
function escapeHtml(text, encode) {
  if (encode) {
    if (ESCAPE_ALL_TEST.test(text)) return text.replace(ESCAPE_ALL_RE, ch => HTML_ESCAPES[ch]);
  } else {
    if (ESCAPE_LOOSE_TEST.test(text)) return text.replace(ESCAPE_LOOSE_RE, ch => HTML_ESCAPES[ch]);
  }
  return text;
}

// encodeURI a link destination, then undo the encoding of literal percent
// signs. Returns null when the destination cannot be encoded at all (for
// example it holds a lone surrogate), which drops the link wrapper.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

const NUMERIC_REF_TEST = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const NUMERIC_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// In ordinary text (never in code or raw HTML), a numeric character
// reference stands for the character it names; zero, out-of-range and
// surrogate values become U+FFFD, and an ampersand that starts no reference
// is escaped so a decoded character can never fuse with its neighbours
// into a new reference.
function decodeNumericRefs(text) {
  if (!NUMERIC_REF_TEST.test(text)) return text;
  return text.replace(NUMERIC_REF_RE, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// ---------------------------------------------------------------------------
// Grammar. The block and inline patterns are the reference grammar's own
// (marked 18.1.3, GFM flavour), because byte-identity is defined by them.
// ---------------------------------------------------------------------------

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
  text: /^[^\n]+/,
};

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
};

const OTHER = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
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
  carriageReturn: /\r\n|\r/g,
  listItemRegex: bullet => new RegExp(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: indent => new RegExp(`^ {0,${clampIndent(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
  hrRegex: indent => new RegExp(`^ {0,${clampIndent(indent)}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
  fencesBeginRegex: indent => new RegExp(`^ {0,${clampIndent(indent)}}(?:\`\`\`|~~~)`),
  headingBeginRegex: indent => new RegExp(`^ {0,${clampIndent(indent)}}#{1,6}(?:\\s|$)`),
  htmlBeginRegex: indent => new RegExp(`^ {0,${clampIndent(indent)}}(?:</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
  blockquoteBeginRegex: indent => new RegExp(`^ {0,${clampIndent(indent)}}>`),
};

// The reference's indent-parameterized patterns are built for
// clamp(indent - 1, 0, 3), not for the indent itself, and are cached per
// clamped value; the list-item pattern is cached per bullet.
function clampIndent(indent) {
  return Math.max(0, Math.min(3, indent - 1));
}

const beginRegexCache = {
  nextBullet: [0, 1, 2, 3].map(n => OTHER.nextBulletRegex(n + 1)),
  hr: [0, 1, 2, 3].map(n => OTHER.hrRegex(n + 1)),
  fences: [0, 1, 2, 3].map(n => OTHER.fencesBeginRegex(n + 1)),
  heading: [0, 1, 2, 3].map(n => OTHER.headingBeginRegex(n + 1)),
  html: [0, 1, 2, 3].map(n => OTHER.htmlBeginRegex(n + 1)),
  quote: [0, 1, 2, 3].map(n => OTHER.blockquoteBeginRegex(n + 1)),
};
const listItemRegexCache = new Map();
function listItemRegexFor(bullet) {
  let re = listItemRegexCache.get(bullet);
  if (!re) {
    re = OTHER.listItemRegex(bullet);
    listItemRegexCache.set(bullet, re);
  }
  return re;
}

// ---------------------------------------------------------------------------
// Emphasis masking. When an inline run contains * _ or ~, the reference
// first rewrites a same-length "masked" copy: escaped punctuation becomes
// '+', code-span interiors and link destinations stop looking like
// delimiters. Delimiter searches then run over the masked copy while the
// tokens are cut from the real one. A stack mirrors nested inline calls.
// ---------------------------------------------------------------------------

const maskStack = [];

function scanMask(masked) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') lastDel = s;
      else lastEm[r] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: masked, lastEm, lastDel };
}

function topMask(masked) {
  const top = maskStack[maskStack.length - 1];
  return top && top.maskedSrc === masked ? top : scanMask(masked);
}

function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, labelKey(s.slice(r + 1, -1))))
      && !(r > 1 && linkInText(text.slice(1, r - 1), links))) return true;
  }
  return false;
}

function buildMask(src, links) {
  let masked = src;
  if (src.includes('[')) {
    const maskRef = match => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(links, labelKey(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(INLINE.reflinkSearch, maskRef) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    masked = masked.replace(INLINE.reflinkSearch, maskRef);
  }
  masked = masked.replace(INLINE.anyPunctuationOutsideCode, (whole, ticks, punct) =>
    punct ? '+'.repeat(whole.length)
      : ticks ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
        : whole);
  masked = masked.replace(INLINE.blockSkip, whole => '[' + 'a'.repeat(whole.length - 2) + ']');
  return masked;
}

// ---------------------------------------------------------------------------
// Lexer state. One fresh state per parse() call: nothing is shared between
// calls, so parse is stateless from the outside.
// ---------------------------------------------------------------------------

function newState() {
  return {
    links: Object.create(null),
    inlineQueue: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
}

// Inline work is queued while blocks are lexed and only run at the end of
// the whole block pass, so a link definition anywhere in the document is
// known before any paragraph's inline content is resolved.
function queueInline(st, src) {
  const tokens = [];
  st.inlineQueue.push({ src, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each returns a token or undefined.
// ---------------------------------------------------------------------------

function tokSpace(st, src) {
  const cap = BLOCK.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  return undefined;
}

function tokIndentedCode(st, src) {
  const cap = BLOCK.code.exec(src);
  if (!cap) return undefined;
  const raw = dropTrailingBlankLines(cap[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(OTHER.codeRemoveIndent, '') };
}

// When a fence's info string is indented, the same indent comes off the
// start of every content line (up to the whitespace actually present).
function compensateFenceIndent(fullRaw, text) {
  const m = fullRaw.match(OTHER.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text.split('\n').map(line => {
    const lead = line.match(OTHER.beginningSpace);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}

function tokFences(st, src) {
  const cap = BLOCK.fences.exec(src);
  if (!cap) return undefined;
  return {
    type: 'code',
    raw: cap[0],
    lang: cap[2] ? cap[2].trim().replace(INLINE.anyPunctuation, '$1') : cap[2],
    text: compensateFenceIndent(cap[0], cap[3] || ''),
  };
}

function tokHeading(st, src) {
  const cap = BLOCK.heading.exec(src);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (OTHER.endingHash.test(text)) {
    const stripped = stripTrailing(text, '#');
    if (!stripped || OTHER.endingSpaceTabChar.test(stripped)) text = stripped.trim();
  }
  return { type: 'heading', raw: stripTrailing(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(st, text) };
}

function tokHr(st, src) {
  const cap = BLOCK.hr.exec(src);
  if (cap) return { type: 'hr', raw: stripTrailing(cap[0], '\n') };
  return undefined;
}

function tokHtmlBlock(st, src) {
  const cap = BLOCK.html.exec(src);
  if (!cap) return undefined;
  const raw = dropTrailingBlankLines(cap[0]);
  return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
}

function tokDef(st, src) {
  const cap = BLOCK.def.exec(src);
  if (!cap) return undefined;
  if (!OTHER.startAngleBracket.test(cap[2]) && closingBracket(cap[2], '()') !== -1) return undefined;
  return {
    type: 'def',
    tag: labelKey(cap[1]),
    raw: stripTrailing(cap[0], '\n'),
    href: cap[2] ? cap[2].replace(OTHER.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '',
    title: cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE.anyPunctuation, '$1') : cap[3],
  };
}

function tokTable(st, src) {
  const cap = BLOCK.table.exec(src);
  if (!cap || !OTHER.tableDelimiter.test(cap[2])) return undefined;
  const headerCells = splitRow(cap[1]);
  const alignCells = cap[2].replace(OTHER.tableAlignChars, '').split('|');
  const rowLines = cap[3]?.trim() ? cap[3].replace(OTHER.tableRowBlankLine, '').split('\n') : [];
  if (headerCells.length !== alignCells.length) return undefined;
  const token = { type: 'table', raw: stripTrailing(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of alignCells) {
    token.align.push(OTHER.tableAlignRight.test(cell) ? 'right'
      : OTHER.tableAlignCenter.test(cell) ? 'center'
        : OTHER.tableAlignLeft.test(cell) ? 'left' : null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    token.header.push({ text: headerCells[i], tokens: queueInline(st, headerCells[i]), header: true, align: token.align[i] });
  }
  for (const line of rowLines) {
    token.rows.push(splitRow(line, token.header.length).map((cell, j) => ({
      text: cell, tokens: queueInline(st, cell), header: false, align: token.align[j],
    })));
  }
  return token;
}

function tokLheading(st, src) {
  const cap = BLOCK.lheading.exec(src);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return { type: 'heading', raw: stripTrailing(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(st, text) };
}

// Paragraph extent, scanned line by line instead of with the reference's
// single large pattern: the first line is always taken; each following
// line is taken unless it opens one of the interrupting constructs (a
// thematic break, heading, blockquote, fence, list item, HTML block, a
// table — a line whose next line is a delimiter row — or a blank line).
// The checks below are the pattern's own lookahead alternatives, evaluated
// per line, which the differential tests against the oracle validate.
const PARA_HR = /^ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const PARA_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const PARA_QUOTE = /^ {0,3}>/;
const PARA_FENCE = /^ {0,3}(?:`{3,}(?=[^`]*$)|~~~)/;
const PARA_LIST = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/;
const PARA_HTML = /^ {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/;
const PARA_DELIM = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;
const PARA_BLANKS = /^[ \t]+$/;

function paragraphInterrupts(src, line, lineStart, lineEnd) {
  if (PARA_BLANKS.test(line)) return lineEnd < src.length;
  const c = line[0];
  if (c === '-' || c === '_' || c === '*' || c === ' ') {
    if (PARA_HR.test(line)) return true;
  }
  if (c === '#' || c === ' ') {
    if (PARA_HEADING.test(line)) return true;
  }
  if (c === '>' || c === ' ') {
    if (PARA_QUOTE.test(line)) return true;
  }
  if (c === '`' || c === '~' || c === ' ') {
    if (PARA_FENCE.test(line)) return true;
  }
  if (c === '*' || c === '+' || c === '-' || c === '1' || c === ' ') {
    if (PARA_LIST.test(line)) return true;
  }
  if (c === '<' || c === ' ') {
    if (PARA_HTML.test(line)) return true;
  }
  // Table: this line could be a header row when the next line is a
  // delimiter row. The header needs a non-space character after optional
  // leading spaces (tabs count as content here, as in the pattern).
  let h = 0;
  while (line[h] === ' ') h++;
  if (h < line.length) {
    const nextStart = lineEnd + 1;
    if (nextStart < src.length) {
      let nextEnd = src.indexOf('\n', nextStart);
      if (nextEnd === -1) nextEnd = src.length;
      if (PARA_DELIM.test(src.slice(nextStart, nextEnd))) return true;
    } else if (nextStart === src.length) {
      // No next line: a delimiter row cannot follow.
      return false;
    }
  }
  return false;
}

function scanParagraph(src) {
  const firstNl = src.indexOf('\n');
  if (firstNl === -1) return src.length > 0 ? src : undefined;
  let end = firstNl;
  let lineStart = firstNl + 1;
  while (lineStart < src.length) {
    let lineEnd = src.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = src.length;
    if (lineEnd === lineStart) break;
    const line = src.slice(lineStart, lineEnd);
    if (paragraphInterrupts(src, line, lineStart, lineEnd)) break;
    end = lineEnd;
    lineStart = lineEnd + 1;
  }
  return src.slice(0, end);
}

function tokParagraph(st, src) {
  const raw = scanParagraph(src);
  if (raw === undefined) return undefined;
  const text = raw.charAt(raw.length - 1) === '\n' ? raw.slice(0, -1) : raw;
  return { type: 'paragraph', raw, text, tokens: queueInline(st, text) };
}

function tokBlockText(st, src) {
  const cap = BLOCK.text.exec(src);
  if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(st, cap[0]) };
  return undefined;
}

function tokBlockquote(st, src) {
  const cap = BLOCK.blockquote.exec(src);
  if (!cap) return undefined;
  let rest = stripTrailing(cap[0], '\n').split('\n');
  let rawOut = '';
  let textOut = '';
  const tokens = [];
  while (rest.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < rest.length; p++) {
      if (OTHER.blockquoteStart.test(rest[p])) {
        chunk.push(rest[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(rest[p]);
      } else break;
    }
    rest = rest.slice(p);
    const chunkRaw = chunk.join('\n');
    const content = chunkRaw
      .replace(OTHER.blockquoteMarkerWhitespace, (_m, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(OTHER.blockquoteSetextReplace, '\n    $1')
      .replace(OTHER.blockquoteSetextReplace2, '');
    rawOut = rawOut ? rawOut + '\n' + chunkRaw : chunkRaw;
    textOut = textOut ? textOut + '\n' + content : content;
    const savedTop = st.top;
    st.top = true;
    blockTokens(st, content, tokens, true);
    st.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const inner = last;
      const combined = inner.raw + '\n' + rest.join('\n').replace(OTHER.blockquoteSetextReplace2, '');
      const reparsed = tokBlockquote(st, combined);
      tokens[tokens.length - 1] = reparsed;
      const leftover = combined.substring(reparsed.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverLines ? rest.slice(0, -leftoverLines) : rest;
      if (consumed.length > 0) rawOut += '\n' + consumed.join('\n');
      textOut = textOut.substring(0, textOut.length - inner.text.length) + reparsed.text;
      rest = rest.slice(consumed.length);
      if (rest.length > 0 && OTHER.blockquoteStart.test(rest[0])) continue;
      break;
    }
    if (last?.type === 'list') {
      const inner = last;
      const combined = inner.raw + '\n' + rest.join('\n');
      const reparsed = tokList(st, combined);
      tokens[tokens.length - 1] = reparsed;
      const extra = reparsed.raw.length > inner.raw.length
        ? combined.slice(inner.raw.length + 1, reparsed.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const segment = rest.slice(0, extra).join('\n');
        rawOut += '\n' + segment;
        textOut += '\n' + segment;
      }
      rest = rest.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw: rawOut, tokens, text: textOut };
}

function tokList(st, src) {
  const first = BLOCK.list.exec(src);
  if (!first) return undefined;
  let rest = src;
  const consumed = () => src.length - rest.length;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPattern = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRegexFor(bulletPattern);
  let prevItemBlankEnd = false;
  while (rest) {
    let endsBlank = false;
    let itemText = '';
    const cap = itemRe.exec(rest);
    if (!cap || BLOCK.hr.test(rest)) break;
    const itemStart = consumed();
    rest = rest.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bullLen = cap[1].length;
    let lineContent = firstLine.replace(OTHER.leadingSpaceTab, v => expandTabs(v, bullLen));
    let nextLine = rest.split('\n', 1)[0];
    let blankItem = !lineContent.trim();
    let indent;
    if (blankItem) {
      indent = bullLen + 1;
    } else {
      indent = lineContent.search(OTHER.nonSpaceChar);
      if (indent > 4) indent = 1;
      itemText = lineContent.slice(indent);
      indent += bullLen;
    }
    if (blankItem && OTHER.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      endsBlank = true;
    }
    if (!endsBlank) {
      const ci = clampIndent(indent);
      const nextBulletRe = beginRegexCache.nextBullet[ci];
      const hrRe = beginRegexCache.hr[ci];
      const fencesRe = beginRegexCache.fences[ci];
      const headingRe = beginRegexCache.heading[ci];
      const htmlRe = beginRegexCache.html[ci];
      const quoteRe = beginRegexCache.quote[ci];
      while (rest) {
        const line = rest.split('\n', 1)[0];
        const expanded = line.replace(OTHER.leadingSpaceTab, v => expandTabs(v));
        if (fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) || quoteRe.test(line)
          || nextBulletRe.test(line) || hrRe.test(line)) break;
        if (expanded.search(OTHER.nonSpaceChar) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (blankItem
            || lineContent.replace(/\t/g, '    ').search(OTHER.nonSpaceChar) >= 4
            || fencesRe.test(lineContent) || headingRe.test(lineContent)
            || htmlRe.test(lineContent) || hrRe.test(lineContent)) break;
          const asSetext = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(lineContent + '\n' + line)
            ? '    ' + expanded.replace(/^ {0,3}/, '')
            : line;
          itemText += '\n' + asSetext;
        }
        blankItem = !line.trim();
        rest = rest.substring(line.length + 1);
        lineContent = expanded.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, consumed());
    if (!list.loose) {
      if (prevItemBlankEnd) list.loose = true;
      else if (OTHER.doubleBlankLine.test(itemRaw)) prevItemBlankEnd = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: !!OTHER.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return undefined;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    st.top = false;
    item.tokens = blockTokens(st, item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter(t => t.type === 'space');
      if (spaces.length > 0 && spaces.some(t => OTHER.anyLine.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
      item.text = item.text.replace(OTHER.listReplaceTask, '');
      firstTok.raw = firstTok.raw.replace(OTHER.listReplaceTask, '');
      firstTok.text = firstTok.text.replace(OTHER.listReplaceTask, '');
      for (let g = st.inlineQueue.length - 1; g >= 0; g--) {
        if (OTHER.listIsTask.test(st.inlineQueue[g].src)) {
          st.inlineQueue[g].src = st.inlineQueue[g].src.replace(OTHER.listReplaceTask, '');
          break;
        }
      }
      const cb = OTHER.listTaskCheckbox.exec(item.raw);
      if (cb) {
        const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (item.tokens[0] && (item.tokens[0].type === 'paragraph' || item.tokens[0].type === 'text') && item.tokens[0].tokens) {
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

// ---------------------------------------------------------------------------
// Inline tokenizers.
// ---------------------------------------------------------------------------

function tokEscape(src) {
  const cap = INLINE.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
  return undefined;
}

function tokTag(st, src) {
  const cap = INLINE.tag.exec(src);
  if (!cap) return undefined;
  if (!st.inLink && OTHER.startATag.test(cap[0])) st.inLink = true;
  else if (st.inLink && OTHER.endATag.test(cap[0])) st.inLink = false;
  if (!st.inRawBlock && OTHER.startPreScriptTag.test(cap[0])) st.inRawBlock = true;
  else if (st.inRawBlock && OTHER.endPreScriptTag.test(cap[0])) st.inRawBlock = false;
  return { type: 'html', raw: cap[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: cap[0] };
}

// True when a tag or autolink inside a link label reaches past the label's
// end, which invalidates the link.
function hasInterveningTag(fullSrc, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const m = INLINE.code.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const m = INLINE.tag.exec(fullSrc.slice(offset + s)) || INLINE.autolink.exec(fullSrc.slice(offset + s));
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token from a link/reflink match: the label is
// inline-lexed immediately, and a link whose label itself emitted a link
// is unwound (no token) exactly as the reference does.
function outputLink(st, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(OTHER.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const tokens = inlineTokens(st, text);
  const emitted = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      st.inRawBlock = savedRawBlock;
      return undefined;
    }
    st.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokLink(st, src) {
  if (st.linkParenPossible === false) return undefined;
  const cap = INLINE.link.exec(src);
  if (!cap) return undefined;
  const bangLen = cap[0].charAt(0) === '!' ? 2 : 1;
  if (hasInterveningTag(src, cap[1], bangLen)) return undefined;
  const hrefTrimmed = cap[2].trim();
  if (OTHER.startAngleBracket.test(hrefTrimmed)) {
    if (!OTHER.endAngleBracket.test(hrefTrimmed)) return undefined;
    const stripped = stripTrailing(hrefTrimmed.slice(0, -1), '\\');
    if ((hrefTrimmed.length - stripped.length) % 2 === 0) return undefined;
  } else {
    const closeIdx = closingBracket(cap[2], '()');
    if (closeIdx === -2) return undefined;
    if (closeIdx > -1) {
      const start = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + closeIdx;
      cap[2] = cap[2].substring(0, closeIdx);
      cap[0] = cap[0].substring(0, start).trim();
      cap[3] = '';
    }
  }
  const backslashStripped = stripTrailing(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - backslashStripped.length) % 2 === 0) return undefined;
  let dest = cap[2].trim();
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  if (OTHER.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
  return outputLink(st, cap, {
    href: dest && dest.replace(INLINE.anyPunctuation, '$1'),
    title: title && title.replace(INLINE.anyPunctuation, '$1'),
  }, cap[0]);
}

function tokReflink(st, src) {
  let cap;
  if ((cap = INLINE.reflink.exec(src)) || (cap = INLINE.nolink.exec(src))) {
    const bangLen = cap[0].charAt(0) === '!' ? 2 : 1;
    if (hasInterveningTag(src, cap[1], bangLen)) return undefined;
    const link = st.links[labelKey(cap[2] || cap[1])];
    if (!link) {
      const first = cap[0].charAt(0);
      return { type: 'text', raw: first, text: first };
    }
    return outputLink(st, cap, link, cap[0]);
  }
  return undefined;
}

function tokEmStrong(st, src, masked, prevChar) {
  const cap = INLINE.emStrongLDelim.exec(src);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return undefined;
  const delimChar = cap[0][0];
  const followsSame = prevChar === delimChar;
  const maskedOffset = masked.length - src.length;
  let runStart = maskedOffset;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsDelim = beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
  let prev = prevChar;
  if (runStart < maskedOffset) prev = beforeRun;
  const prevIsPunct = runStart < maskedOffset ? beforeIsDelim : !!INLINE.punctuation.exec(prev);
  if (cap[4] && prev.match(OTHER.unicodeAlphaNumeric)) return undefined;
  const punctAfter = cap[1] || cap[3] || '';
  if (!punctAfter || !prev || prevIsPunct) {
    const openerLen = [...cap[0]].length - 1;
    let leftover = openerLen;
    let fudge = 0;
    const totalRun = maskedOffset - runStart + openerLen;
    const canClose = !!beforeRun.trim() && (!!punctAfter || delimChar === '*' && !beforeIsDelim);
    if (delimChar !== '*' && delimChar !== '_') return undefined;
    const rdelim = delimChar === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastPossible = topMask(masked).lastEm[delimChar];
    const posInMasked = maskedOffset + openerLen;
    if (lastPossible < posInMasked) return undefined;
    const rest = masked.slice(-src.length + openerLen);
    const allowed = lastPossible - posInMasked;
    let match;
    rdelim.lastIndex = 0;
    while ((match = rdelim.exec(rest)) !== null && !(match.index > allowed)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      const gLen = [...g].length;
      if (match[3] || match[4]) {
        leftover += gLen;
        continue;
      }
      if (match[5] || match[6] || canClose) {
        if (followsSame && (match[5] || match[6])) break;
        if (totalRun % 3 && !((totalRun + gLen) % 3)) {
          fudge += gLen;
          continue;
        }
      }
      leftover -= gLen;
      if (leftover > 0) continue;
      const useLen = Math.min(gLen, gLen + leftover + fudge);
      const firstCharLen = [...match[0]][0].length;
      const raw = src.slice(0, openerLen + match.index + firstCharLen + useLen);
      if (Math.min(openerLen, useLen) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: inlineTokens(st, inner) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: inlineTokens(st, inner) };
    }
  }
  return undefined;
}

function tokCodespan(src) {
  const cap = INLINE.code.exec(src);
  if (!cap) return undefined;
  let text = cap[2].replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  return { type: 'codespan', raw: cap[0], text };
}

function tokBr(src) {
  const cap = INLINE.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
  return undefined;
}

function tokDel(st, src, masked, prevChar) {
  const cap = INLINE.delLDelim.exec(src);
  if (!cap) return undefined;
  if (!cap[1] || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const openerLen = [...cap[0]].length - 1;
    let leftover = openerLen;
    const lastPossible = topMask(masked).lastDel;
    const posInMasked = masked.length - src.length + openerLen;
    if (lastPossible < posInMasked) return undefined;
    const rest = masked.slice(-src.length + openerLen);
    const allowed = lastPossible - posInMasked;
    let match;
    INLINE.delRDelim.lastIndex = 0;
    while ((match = INLINE.delRDelim.exec(rest)) !== null && !(match.index > allowed)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      const gLen = [...g].length;
      if (gLen !== openerLen) continue;
      if (match[3] || match[4]) {
        leftover += gLen;
        continue;
      }
      leftover -= gLen;
      if (leftover > 0) continue;
      const useLen = Math.min(gLen, gLen + leftover);
      const firstCharLen = [...match[0]][0].length;
      const raw = src.slice(0, openerLen + match.index + firstCharLen + useLen);
      const inner = raw.slice(openerLen, -openerLen);
      return { type: 'del', raw, text: inner, tokens: inlineTokens(st, inner) };
    }
  }
  return undefined;
}

function tokAutolink(src) {
  const cap = INLINE.autolink.exec(src);
  if (!cap) return undefined;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokUrl(src) {
  const cap = INLINE.url.exec(src);
  if (!cap) return undefined;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + cap[0];
  } else {
    let prev;
    do {
      prev = cap[0];
      cap[0] = INLINE.backpedal.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokInlineText(st, src) {
  const cap = INLINE.text.exec(src);
  if (!cap) return undefined;
  const inRaw = st.inRawBlock;
  return { type: 'text', raw: cap[0], text: inRaw ? cap[0] : decodeNumericRefs(cap[0]), escaped: inRaw };
}

// Cheap necessary-condition gate for the url tokenizer: a scheme prefix,
// a www. start, a mailto:/xmpp: prefix, or an email-shaped local part.
function urlGate(src) {
  const c = src[0];
  if (c === 'w') {
    if (src.startsWith('www.')) return true;
  } else if (c === 'm') {
    if (src.startsWith('mailto:')) return true;
  } else if (c === 'x') {
    if (src.startsWith('xmpp:')) return true;
  }
  if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
    const head = src.substring(0, 8).toLowerCase();
    if (head.startsWith('http://') || head.startsWith('https://') || head.startsWith('ftp://')) return true;
  }
  let i = 0;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    const isEmailChar = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || code === 46 || code === 95 || code === 43 || code === 45;
    if (!isEmailChar) break;
    i++;
  }
  return i > 0 && src[i] === '@';
}

// ---------------------------------------------------------------------------
// Inline driver. Tokenizers are attempted in the reference's order, but
// each is gated on the only starting characters its pattern can match, so
// most positions run one or two patterns instead of eleven.
// ---------------------------------------------------------------------------

function inlineTokens(st, src, tokens = []) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  try {
    return inlineTokensInner(st, src, tokens);
  } finally {
    st.linkParenPossible = savedParen;
  }
}

function inlineTokensInner(st, src, tokens) {
  let masked = src;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = buildMask(src, st.links);
  }
  maskStack.push(scanMask(masked));
  try {
    let prevChar = '';
    let wasText = false;
    let lastLen = Infinity;
    while (src) {
      if (src.length < lastLen) lastLen = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!wasText) prevChar = '';
      wasText = false;
      let token;
      const c = src[0];
      if (c === '\\' && (token = tokEscape(src))) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if (c === '<' && (token = tokTag(st, src))) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((c === '[' || (c === '!' && src[1] === '[')) && (token = tokLink(st, src))) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((c === '[' || (c === '!' && src[1] === '[')) && (token = tokReflink(st, src))) {
        const last = tokens[tokens.length - 1];
        if (token.type === 'text' && last?.type === 'text') {
          last.raw += token.raw;
          last.text += token.text;
        } else {
          tokens.push(token);
        }
        src = src.substring(token.raw.length);
        continue;
      }
      if ((c === '*' || c === '_') && (token = tokEmStrong(st, src, masked, prevChar))) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if (c === '`' && (token = tokCodespan(src))) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if ((c === '\\' || c === ' ') && (token = tokBr(src))) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if (c === '~' && (token = tokDel(st, src, masked, prevChar))) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if (c === '<' && (token = tokAutolink(src))) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      if (!st.inLink && urlGate(src) && (token = tokUrl(src))) {
        tokens.push(token);
        src = src.substring(token.raw.length);
        continue;
      }
      token = tokInlineText(st, src);
      if (token) {
        const last = tokens[tokens.length - 1];
        if (last?.type === 'text') {
          last.raw += token.raw;
          last.text += token.text;
        } else {
          tokens.push(token);
        }
        if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
        wasText = true;
        src = src.substring(token.raw.length);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  } finally {
    maskStack.pop();
  }
}

// ---------------------------------------------------------------------------
// Block driver, with the same gating idea: each tokenizer runs only when
// the line's opening characters allow its pattern to match.
// ---------------------------------------------------------------------------

function indentWidth(src) {
  let i = 0;
  while (i < 3 && src[i] === ' ') i++;
  return i;
}

function hrPossible(src) {
  let dash = 0;
  let under = 0;
  let star = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') break;
    if (ch === '-') dash++;
    else if (ch === '_') under++;
    else if (ch === '*') star++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return dash >= 3 || under >= 3 || star >= 3;
}

// Necessary-condition gate for the table tokenizer, hand-scanned: the
// second line must be a delimiter row (cells of dashes with optional
// colons, separated by pipes) containing at least one ':' or '|'. The
// table pattern itself verifies any positive.
function tablePossible(src) {
  const nl = src.indexOf('\n');
  if (nl <= 0) return false;
  let i = nl + 1;
  let spaces = 0;
  while (src[i] === ' ' && spaces < 4) {
    i++;
    spaces++;
  }
  if (spaces > 3) return false;
  let marked = false;
  if (src[i] === '|') {
    marked = true;
    i++;
    while (src[i] === ' ') i++;
  }
  for (;;) {
    if (src[i] === ':') {
      marked = true;
      i++;
    }
    let dashes = 0;
    while (src[i] === '-') {
      i++;
      dashes++;
    }
    if (dashes === 0) return false;
    if (src[i] === ':') {
      marked = true;
      i++;
    }
    while (src[i] === ' ') i++;
    if (src[i] !== '|') break;
    marked = true;
    i++;
    while (src[i] === ' ') i++;
    if (src[i] === '\n' || i >= src.length) return marked;
  }
  return (src[i] === '\n' || i >= src.length) && marked;
}

// A setext underline can only appear before the first blank line (the
// heading text cannot cross one), so the gate scans just those lines,
// by hand: up to three spaces, a run of '=' or '-', then blanks.
function lheadingPossible(src) {
  let pos = src.indexOf('\n');
  if (pos === -1) return false;
  pos++;
  while (pos < src.length) {
    let end = src.indexOf('\n', pos);
    if (end === -1) end = src.length;
    let i = pos;
    let spaces = 0;
    while (i < end && src[i] === ' ' && spaces <= 3) {
      i++;
      spaces++;
    }
    if (i === end) return false;
    const ch = src[i];
    if (spaces <= 3 && (ch === '=' || ch === '-')) {
      let j = i;
      while (j < end && src[j] === ch) j++;
      while (j < end && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j === end) return true;
    }
    pos = end + 1;
  }
  return false;
}

function blockTokens(st, src, tokens = [], inside = false) {
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let token;
    const c = src[0];
    if ((c === '\n' || c === ' ' || c === '\t') && (token = tokSpace(st, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (token.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(token);
      continue;
    }
    if ((src.startsWith('    ') || (c === '\t') || (c === ' ' && /^ {1,3}\t/.test(src))) && (token = tokIndentedCode(st, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        st.inlineQueue[st.inlineQueue.length - 1].src = last.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    const ind = indentWidth(src);
    const lead = src[ind];
    if ((lead === '`' || lead === '~') && (token = tokFences(st, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (lead === '#' && (token = tokHeading(st, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (hrPossible(src) && (token = tokHr(st, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (lead === '>' && (token = tokBlockquote(st, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((lead === '*' || lead === '+' || lead === '-' || (lead >= '0' && lead <= '9')) && (token = tokList(st, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (lead === '<' && (token = tokHtmlBlock(st, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (lead === '[' && (token = tokDef(st, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.raw;
        st.inlineQueue[st.inlineQueue.length - 1].src = last.text;
      } else {
        if (!st.links[token.tag]) st.links[token.tag] = { href: token.href, title: token.title };
        tokens.push(token);
      }
      continue;
    }
    if (tablePossible(src) && (token = tokTable(st, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (lheadingPossible(src) && (token = tokLheading(st, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (st.top && (token = tokParagraph(st, src))) {
      const last = tokens[tokens.length - 1];
      if (inside && last?.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        st.inlineQueue.pop();
        st.inlineQueue[st.inlineQueue.length - 1].src = last.text;
      } else {
        tokens.push(token);
      }
      inside = false;
      src = src.substring(token.raw.length);
      continue;
    }
    if (token = tokBlockText(st, src)) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        st.inlineQueue.pop();
        st.inlineQueue[st.inlineQueue.length - 1].src = last.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  st.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer: walk the token tree emitting HTML directly.
// ---------------------------------------------------------------------------

function renderBlocks(tokens) {
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
        out += `<h${token.depth}>${renderInline(token.tokens)}</h${token.depth}>\n`;
        break;
      case 'code': {
        const lang = (token.lang || '').match(/^\S*/)?.[0];
        const code = token.text ? token.text.replace(/\n$/, '') + '\n' : '';
        out += lang
          ? `<pre><code class="language-${escapeHtml(lang, false)}">${escapeHtml(code, true)}</code></pre>\n`
          : `<pre><code>${escapeHtml(code, true)}</code></pre>\n`;
        break;
      }
      case 'table': {
        let headerRow = '';
        for (const cell of token.header) headerRow += renderTableCell(cell);
        let body = '';
        for (const row of token.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${headerRow}</tr>\n</thead>\n${body}</table>\n`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(token.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let items = '';
        for (const item of token.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        const tag = token.ordered ? 'ol' : 'ul';
        const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += `<input ${token.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'html':
        out += token.text;
        break;
      case 'paragraph':
        out += `<p>${renderInline(token.tokens)}</p>\n`;
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

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return `${open}${renderInline(cell.tokens)}</${tag}>\n`;
}

function renderInline(tokens, textOnly = false) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
        out += renderTextToken(token, textOnly);
        break;
      case 'html':
        out += textOnly ? token.text : token.text;
        break;
      case 'link': {
        if (textOnly) {
          out += renderInline(token.tokens, true);
          break;
        }
        const body = token.autolink ? escapeHtml(token.text, true) : renderInline(token.tokens);
        const href = cleanUrl(token.href);
        if (href === null) {
          out += body;
          break;
        }
        let tag = `<a href="${escapeHtml(href, token.autolink)}"`;
        if (token.title) tag += ` title="${escapeHtml(token.title, false)}"`;
        out += `${tag}>${body}</a>`;
        break;
      }
      case 'image': {
        const alt = renderInline(token.tokens, true);
        if (textOnly) {
          out += alt;
          break;
        }
        const href = cleanUrl(token.href);
        if (href === null) {
          out += escapeHtml(alt, false);
          break;
        }
        let tag = `<img src="${escapeHtml(href, false)}" alt="${escapeHtml(alt, false)}"`;
        if (token.title) tag += ` title="${escapeHtml(token.title, false)}"`;
        out += tag + '>';
        break;
      }
      case 'checkbox':
        out += textOnly ? token.raw : `<input ${token.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'strong':
        out += textOnly ? renderInline(token.tokens, true) : `<strong>${renderInline(token.tokens)}</strong>`;
        break;
      case 'em':
        out += textOnly ? renderInline(token.tokens, true) : `<em>${renderInline(token.tokens)}</em>`;
        break;
      case 'codespan':
        out += textOnly ? token.text : `<code>${escapeHtml(token.text, true)}</code>`;
        break;
      case 'br':
        out += textOnly ? '' : '<br>';
        break;
      case 'del':
        out += textOnly ? renderInline(token.tokens, true) : `<del>${renderInline(token.tokens)}</del>`;
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

function renderTextToken(token, textOnly) {
  if (textOnly) {
    return token.tokens ? renderInline(token.tokens, true) : token.text;
  }
  if (token.tokens) return renderInline(token.tokens);
  if ('escaped' in token && token.escaped) return token.text;
  return escapeHtml(token.text, false);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const st = newState();
  const src = markdown.replace(OTHER.carriageReturn, '\n');
  const tokens = [];
  blockTokens(st, src, tokens);
  for (let i = 0; i < st.inlineQueue.length; i++) {
    const entry = st.inlineQueue[i];
    st.inRawBlock = false;
    inlineTokens(st, entry.src, entry.tokens);
  }
  return renderBlocks(tokens);
}
