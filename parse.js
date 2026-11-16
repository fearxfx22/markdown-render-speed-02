// A fast, dependency-free Markdown renderer whose parse(markdown) returns
// exactly the HTML marked 18.1.3 renders with its defaults (GFM on, breaks
// off, pedantic off, async off). Written from scratch against the CommonMark
// 0.31.2 and GFM 0.29 specifications, with marked's output as the reference
// for every edge case. No part of marked's code is used here: the block and
// inline passes are single-pass char-code scanners, not regex engines.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Escape &, <, >, ", ' — but leave a valid entity reference alone (encode=false).
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      // keep a valid entity reference: &#digits; &#xhex; or &word;
      if (isEntityRef(s, i)) continue;
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape every one of &, <, >, ", ' (encode=true).
function escAll(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Is there a valid entity reference starting at s[i] ('&')?
// &#digits; (1-7 digits), &#x hex; / &#X hex; (1-6 hex), or &word;
function isEntityRef(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return false;
  if (s.charCodeAt(j) === 35) { // #
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x X
      j++;
      const st = j;
      while (j < n && isHex(s.charCodeAt(j))) j++;
      return j > st && j - st <= 6 && j < n && s.charCodeAt(j) === 59;
    }
    const st = j;
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    return j > st && j - st <= 7 && j < n && s.charCodeAt(j) === 59;
  }
  const st = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { j++; continue; }
    break;
  }
  return j > st && j < n && s.charCodeAt(j) === 59;
}

function isHex(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

// Decode numeric character references; a bare & that does not start a valid
// entity becomes &amp;. A decoded character never joins its neighbours into
// a new reference. (Mirrors marked's Ie: only runs when the string holds a
// numeric reference, and a named entity such as &copy; is left alone.)
function decodeNumRefs(s) {
  if (!/&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/.test(s)) return s;
  let out = '';
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s.charCodeAt(i) === 38) { // &
      if (i + 1 < n && s.charCodeAt(i + 1) === 35) { // &#
        let j = i + 2, hex = false;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
        const ds = j;
        while (j < n && (hex ? isHex(s.charCodeAt(j)) : (s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57))) j++;
        const len = j - ds;
        if (len > 0 && ((hex && len <= 6) || (!hex && len <= 7)) && j < n && s.charCodeAt(j) === 59) {
          const code = hex ? parseInt(s.slice(ds, j), 16) : parseInt(s.slice(ds, j), 10);
          let rep;
          if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) rep = '\uFFFD';
          else if (code === 38) rep = '&amp;';
          else rep = String.fromCodePoint(code);
          out += s.slice(start, i) + rep;
          i = j + 1; start = i;
          continue;
        }
      }
      // not a valid numeric reference: leave a valid entity alone, else escape
      if (isEntityRef(s, i)) { i++; continue; }
      out += s.slice(start, i) + '&amp;';
      i++; start = i;
      continue;
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Clean a URL the way marked does: encodeURI, then unescape %25 back to %.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link label: trim, collapse whitespace runs to one space,
// then case-fold (lower, upper, lower) as commonmark.js does.
function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs to spaces to the next multiple of 4, counting from `indent`.
function expandTabs(s, indent) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let col = indent;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const add = 4 - (col % 4);
      out += '    '.slice(0, add);
      col += add;
    } else { out += ch; col++; }
  }
  return out;
}

// Remove trailing occurrences of char code `c`.
function rtrimChar(s, c) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === c) e--;
  return s.slice(0, e);
}

// Find the index of the closing bracket matching the opening bracket at the
// start of `str`, skipping escaped chars. Returns the index of the closer,
// -1 when there is none, -2 when more opens than closes.
function findClosingBracket(str, open, close) {
  if (str.indexOf(open) === -1 && str.indexOf(close) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') { i++; continue; }
    if (ch === open) level++;
    else if (ch === close) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Split a table row into cells, honouring escaped pipes.
function splitCells(row, count) {
  let r = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|') {
      let esc = false, k = i - 1;
      while (k >= 0 && row[k] === '\\') { esc = !esc; k--; }
      r += esc ? '|' : ' |';
    } else r += row[i];
  }
  let cells = r.split(' |');
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Unicode helpers for emphasis flanking (punctuation / whitespace).
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch) { return ch !== '' && PUNCT_RE.test(ch); }
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }
// Unicode whitespace (for flanking rules): ASCII space plus NBSP and the
// other Unicode space separators.
function isUniSpace(ch) {
  if (ch === '') return true;
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288;
}


// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Nodes produced by the scanner (k = kind):
//  0 text (s = raw text, raw = was inside <pre>/<script>/<style>/<textarea>)
//  1 delimiter run (ch = '*'|'_'|'~', n = length, open, close)
//  2 code span (s = processed content)
//  3 link/image (href, title, label = raw label text, img, auto, labelNodes)
//  4 raw html (s)
//  5 hard break
//  6 escaped char (s = the char itself)
// After scanning, delimiter runs are resolved into em/strong/del nodes:
//  7 em (c = child nodes), 8 strong, 9 del

function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// a character that can appear in the local part of a bare email address
function isEmailCharCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 95 || c === 45 || c === 43;
}

// Left/right flanking for a delimiter run, from the chars around it.
function flankInfo(prev, next) {
  const prevIsSpace = prev === '' || isUniSpace(prev);
  const nextIsSpace = next === '' || isUniSpace(next);
  const prevIsPunct = prev !== '' && (isAsciiPunctCode(prev.charCodeAt(0)) || isPunct(prev));
  const nextIsPunct = next !== '' && (isAsciiPunctCode(next.charCodeAt(0)) || isPunct(next));
  const left = !nextIsSpace && (!nextIsPunct || prevIsSpace || prevIsPunct);
  const right = !prevIsSpace && (!prevIsPunct || nextIsSpace || nextIsPunct);
  return { left, right, prevIsPunct, nextIsPunct };
}

// Update the inline state from a matched raw HTML tag.
function updateTagState(tag, st) {
  const low = tag.toLowerCase();
  if (!st.inLink && /^<a(?:\s[^>]*)?>/.test(low)) st.inLink = true;
  else if (st.inLink && /^<\/a\s*>/.test(low)) st.inLink = false;
  if (!st.inRawBlock && /^<(pre|script|style|textarea)(?:\s[^>]*)?>/.test(low)) st.inRawBlock = true;
  else if (st.inRawBlock && /^<\/(pre|script|style|textarea)\s*>/.test(low)) st.inRawBlock = false;
}

// --- link destination / title parsing (shared by inline links and defs) ---

function parseDest(src, i) {
  const n = src.length;
  if (i < n && src.charCodeAt(i) === 60) { // <
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 62) return { href: src.slice(i + 1, j), next: j + 1 }; // >
      if (c === 10 || c === 60) return null; // \n or < not allowed
      if (c === 92) j += 2; else j++;
    }
    return null;
  }
  let j = i, level = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 10 || c === 9) break;
    if (c < 32) return null;
    if (c === 92) { j += 2; continue; }
    if (c === 40) level++;
    else if (c === 41) {
      if (level === 0) break;
      level--;
    }
    j++;
  }
  if (level !== 0) return null;
  // an empty destination is allowed: [link]()
  return { href: src.slice(i, j), next: j };
}

function parseTitle(src, i) {
  const n = src.length;
  if (i >= n) return null;
  const q = src.charCodeAt(i);
  if (q === 34 || q === 39) { // " or '
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === q) return { title: src.slice(i + 1, j), next: j + 1 };
      if (q === 39 && c === 10) {
        if (j + 1 < n && src.charCodeAt(j + 1) === 10) return null;
      }
      j++;
    }
    return null;
  }
  if (q === 40) { // (
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 41) return { title: src.slice(i + 1, j), next: j + 1 };
      if (c === 40) return null;
      j++;
    }
    return null;
  }
  return null;
}

function skipLinkWs(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Does src[start..end] match marked's label-content pattern (the `re`
// alternation: nested brackets, escapes, code spans whose closer is the
// next backtick run of any length, two-or-more backticks directly before
// the closing `]`, plain characters)? `end` is the index of the `]` that
// would close the label. Used to find the label end with the regex's
// backtracking semantics: the label ends at the first `]` whose content
// matches, and a longer label is only tried when the shorter one yields
// no link.
function labelContentMatches(src, start, end) {
  let i = start;
  let level = 0;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // escape
    if (c === 60) {
      // An HTML tag or autolink swallows a ] inside it, so the label
      // cannot end there. Skip a tag that completes inside the content;
      // if it runs past the candidate ] the content does not match.
      const tag = matchInlineTag(src, i);
      if (tag) {
        if (tag.next <= end) { i = tag.next; continue; }
        return false;
      }
      const al = matchAutolink(src, i);
      if (al) {
        if (al.next <= end) { i = al.next; continue; }
        return false;
      }
    }
    if (c === 96) {
      let j = i, run = 0;
      while (j < end && src.charCodeAt(j) === 96) { j++; run++; }
      if (level >= 1) { i = j; continue; } // plain char in a nested bracket
      let k = j, closeEnd = -1;
      while (k < end) {
        if (src.charCodeAt(k) === 96) {
          let m = k;
          while (m < end && src.charCodeAt(m) === 96) m++;
          closeEnd = m;
          break;
        }
        k++;
      }
      if (closeEnd !== -1) { i = closeEnd; continue; }
      if (run >= 2 && j === end) { i = j; continue; } // literal, ends label
      return false;
    }
    if (c === 91) { level++; i++; continue; } // [
    if (c === 93) { // ]
      if (level > 0) { level--; i++; continue; }
      return false; // a ] at the label's own level is not part of it
    }
    i++;
  }
  return level === 0;
}

// Find the matching ] for the [ at position `open`, honouring escapes,
// code spans and nested brackets. Returns the index of the matching ] or
// -1. This is the first `]` whose content matches the label pattern;
// callers that need a longer label (backtracking) enumerate candidates
// with labelContentMatches directly.
function findLabelEnd(src, open, from) {
  const n = src.length;
  for (let end = from === undefined ? open + 1 : from; end < n; end++) {
    if (src.charCodeAt(end) !== 93) continue; // not ]
    if (labelContentMatches(src, open + 1, end)) return end;
  }
  return -1;
}

// --- emStrong masking (marked's #n) ---
// Ranges of an inline source that emphasis resolution must not see,
// because a code span, a link, an HTML tag, or a reference link covers
// them. Two passes over a length-preserving copy of the source:
// anyPunctuationOutsideCode masks the inner backticks of well-formed
// (equal-run) code spans and escaped punctuation to '+'; blockSkip then
// finds link / code / html spans in that copy and records them. A
// delimiter run whose position falls inside a recorded range is hidden
// from the emphasis scan (it renders literally).

function maskedSource(src) {
  const n = src.length;
  const parts = [];
  let i = 0, start = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 96) { // backtick run: try an equal-run code span
      let j = i, run = 0;
      while (j < n && src.charCodeAt(j) === 96) { j++; run++; }
      let k = j, closeStart = -1, closeEnd = -1;
      while (k < n) {
        if (src.charCodeAt(k) === 96) {
          let m = k, r2 = 0;
          while (m < n && src.charCodeAt(m) === 96) { m++; r2++; }
          if (r2 === run) { closeStart = k; closeEnd = m; break; }
          k = m;
        } else k++;
      }
      if (closeStart !== -1) {
        if (i > start) parts.push(src.slice(start, i));
        parts.push(src.slice(i, j)); // opening run, kept
        let content = src.slice(j, closeStart);
        if (content.indexOf('`') !== -1) content = content.replace(/`/g, '+');
        parts.push(content);
        parts.push(src.slice(closeStart, closeEnd)); // closing run, kept
        i = closeEnd;
        start = i;
        continue;
      }
      i = j; // bare run: no masking
      continue;
    }
    if (c === 92 && i + 1 < n && isPunct(src[i + 1])) { // \ + punct -> ++
      if (i > start) parts.push(src.slice(start, i));
      parts.push('++');
      i += 2;
      start = i;
      continue;
    }
    i++;
  }
  if (n > start) parts.push(src.slice(start, n));
  return parts.join('');
}

// Match the blockSkip link alternative at masked[i] === '['.
// Returns the index just past the closing ')' or -1.
function matchBlockSkipLink(masked, i) {
  const n = masked.length;
  let j = i + 1;
  while (j < n) {
    const c = masked.charCodeAt(j);
    if (c === 96) { // code span in the label (equal runs)
      let k = j, run = 0;
      while (k < n && masked.charCodeAt(k) === 96) { k++; run++; }
      let m = k, closeEnd = -1;
      while (m < n) {
        if (masked.charCodeAt(m) === 96) {
          let q = m, r2 = 0;
          while (q < n && masked.charCodeAt(q) === 96) { q++; r2++; }
          if (r2 === run) { closeEnd = q; break; }
          m = q;
        } else m++;
      }
      if (closeEnd === -1) return -1;
      j = closeEnd;
      continue;
    }
    if (c === 91 || c === 93) { // [ or ] : a [ fails the label, a ] ends it
      if (c === 91) return -1;
      break;
    }
    j++;
  }
  if (j >= n || masked.charCodeAt(j) !== 93) return -1;
  // label ends at j; a '(' must follow, then a destination with at most
  // one level of balanced parens, then ')'
  if (j + 1 >= n || masked.charCodeAt(j + 1) !== 40) return -1;
  let k = j + 2, level = 0;
  while (k < n) {
    const c = masked.charCodeAt(k);
    if (c === 92) { k += 2; continue; }
    if (c === 40) level++;
    else if (c === 41) {
      if (level === 0) return k + 1;
      level--;
    }
    k++;
  }
  return -1;
}

// Match the blockSkip precode-code alternative whose code span starts at
// masked[b] (a backtick run). Returns [codeStart, codeEnd] or null.
// The match also needs a one-character non-backtick prefix before b
// (or b === 0); the prefix itself is not part of the masked range.
function matchBlockSkipCode(masked, b) {
  const n = masked.length;
  if (b > 0 && masked.charCodeAt(b - 1) === 96) return null;
  let j = b, run = 0;
  while (j < n && masked.charCodeAt(j) === 96) { j++; run++; }
  // content: 1+ non-backtick chars, then an equal closing run not
  // followed by a backtick
  let k = j;
  while (k < n) {
    if (masked.charCodeAt(k) === 96) {
      let m = k, r2 = 0;
      while (m < n && masked.charCodeAt(m) === 96) { m++; r2++; }
      if (r2 === run) return [b, m];
      k = m;
    } else k++;
  }
  return null;
}

// Match the blockSkip html alternative at masked[i] === '<'.
// Returns the index just past '>' or -1.
function matchBlockSkipHtml(masked, i) {
  if (i + 1 < masked.length && masked.charCodeAt(i + 1) === 32) return -1;
  const end = masked.indexOf('>', i + 1);
  if (end === -1) return -1;
  for (let k = i + 1; k < end; k++) {
    if (masked.charCodeAt(k) === 60) return -1;
  }
  return end + 1;
}

// Ranges [start, end) of src hidden from emphasis resolution.
function computeMaskedRanges(src, links) {
  const ranges = [];
  if (src.indexOf('[') === -1 && src.indexOf('`') === -1 && src.indexOf('<') === -1) return ranges;
  const masked = maskedSource(src);
  const n = masked.length;
  let i = 0;
  while (i < n) {
    const c = masked.charCodeAt(i);
    if (c === 91) { // [ : link alternative
      const end = matchBlockSkipLink(masked, i);
      if (end !== -1) {
        ranges.push([i, end]);
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) { // backtick: precode-code (prefix is the previous char)
      if (i === 0 || masked.charCodeAt(i - 1) !== 96) {
        const hit = matchBlockSkipCode(masked, i);
        if (hit) {
          ranges.push(hit);
          i = hit[1];
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 60) { // < : html alternative
      const end = matchBlockSkipHtml(masked, i);
      if (end !== -1) {
        ranges.push([i, end]);
        i = end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return ranges;
}

// --- inline scanner ---

// Scan src into nodes. links = link reference map. st = {inLink, inRawBlock}
// (mutated as the scan proceeds; the caller continues from the final state).
// Returns {nodes, hasLink}; hasLink is true only when a non-image link was
// formed (images and autolinks do not count — marked's linkEmitted rule).
function scanInline(src, links, st) {
  const nodes = [];
  const n = src.length;
  let i = 0;
  let hasLink = false;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) nodes.push({ k: 0, s: src.slice(textStart, end), raw: st.inRawBlock });
  };
  // Fast path: plain text with no special chars and no GFM autolink
  // candidate (www., ://, @) is a single text node.
  let plain = true;
  for (let k = 0; k < n; k++) {
    const c = src.charCodeAt(k);
    if (c === 42 || c === 95 || c === 96 || c === 91 || c === 93 || c === 33 || c === 60 || c === 38 || c === 92 || c === 126 || c === 10) { plain = false; break; }
  }
  if (plain && src.indexOf('www.') === -1 && src.indexOf('://') === -1 && src.indexOf('@') === -1) {
    nodes.push({ k: 0, s: src, raw: st.inRawBlock });
    return { nodes, hasLink: false };
  }
  while (i < n) {
    const c = src.charCodeAt(i);
    // escape: \ + ascii punctuation
    if (c === 92 && i + 1 < n && isAsciiPunctCode(src.charCodeAt(i + 1))) {
      flushText(i);
      nodes.push({ k: 6, s: src[i + 1] });
      i += 2; textStart = i;
      continue;
    }
    // hard break: backslash + newline
    if (c === 92 && i + 1 < n && src.charCodeAt(i + 1) === 10) {
      let j = i + 2;
      while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
      if (j < n && src.charCodeAt(j) !== 10) {
        flushText(i);
        nodes.push({ k: 5 });
        i = j; textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // code span
    if (c === 96) {
      let j = i, run = 0;
      while (j < n && src.charCodeAt(j) === 96) { j++; run++; }
      let k = j, found = -1, foundEnd = -1;
      while (k < n) {
        if (src.charCodeAt(k) === 96) {
          let m = k, r2 = 0;
          while (m < n && src.charCodeAt(m) === 96) { m++; r2++; }
          if (r2 === run) { found = k; foundEnd = m; break; }
          k = m;
        } else k++;
      }
      if (found !== -1) {
        flushText(i);
        let content = src.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        nodes.push({ k: 2, s: content });
        i = foundEnd; textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // raw html tag / autolink at <
    if (c === 60) {
      const tag = matchInlineTag(src, i);
      if (tag) {
        flushText(i);
        updateTagState(tag.text, st);
        nodes.push({ k: 4, s: tag.text });
        i = tag.next; textStart = i;
        continue;
      }
      const al = matchAutolink(src, i);
      if (al) {
        flushText(i);
        nodes.push({ k: 3, href: al.href, title: '', label: al.text, img: false, auto: true, labelNodes: null });
        i = al.next; textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // link / image / reflink at [ or ![
    if (c === 91 || (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91)) {
      const isImg = c === 33;
      const open = isImg ? i + 1 : i;
      // Try candidate label ends shortest-first; a longer label is only
      // used when the shorter one yields no link (marked's lazy label
      // regex plus backtracking on the destination).
      let close = findLabelEnd(src, open);
      while (close !== -1) {
        const label = src.slice(open + 1, close);
        const after = close + 1;
        let done = false;
        if (after < n && src.charCodeAt(after) === 40) {
          const lk = tryInlineLink(src, after, label, isImg, links, st);
          if (lk) {
            flushText(i);
            nodes.push(lk.node);
            if (!isImg) hasLink = true;
            i = lk.next; textStart = i;
            done = true;
          }
        }
        if (!done) {
          const rl = tryRefLink(src, close, label, isImg, links, st);
          if (rl) {
            flushText(i);
            nodes.push(rl.node);
            if (!isImg) hasLink = true;
            i = rl.next; textStart = i;
            done = true;
          }
        }
        if (done) break;
        close = findLabelEnd(src, open, close + 1);
      }
      if (close !== -1) continue;
      i++;
      continue;
    }
    // strikethrough delimiter ~
    if (c === 126) {
      let j = i, run = 0;
      while (j < n && src.charCodeAt(j) === 126) { j++; run++; }
      if (run === 1 || run === 2) {
        const prev = i === 0 ? '' : src[i - 1];
        const next = j < n ? src[j] : '';
        const fl = flankInfo(prev, next);
        if (fl.left || fl.right) {
          flushText(i);
          nodes.push({ k: 1, ch: '~', n: run, open: fl.left, close: fl.right, pv: prev, nx: next, pos: i });
          i = j; textStart = i;
          continue;
        }
      }
      i = j;
      continue;
    }
    // emphasis delimiter * or _
    if (c === 42 || c === 95) {
      const ch = c === 42 ? '*' : '_';
      let j = i, run = 0;
      while (j < n && src.charCodeAt(j) === c) { j++; run++; }
      const prev = i === 0 ? '' : src[i - 1];
      const next = j < n ? src[j] : '';
      const fl = flankInfo(prev, next);
      let canOpen, canClose;
      if (ch === '*') {
        canOpen = fl.left;
        canClose = fl.right;
      } else {
        canOpen = fl.left && (!fl.right || fl.prevIsPunct);
        canClose = fl.right && (!fl.left || fl.nextIsPunct);
      }
      if (canOpen || canClose) {
        flushText(i);
        nodes.push({ k: 1, ch, n: run, open: canOpen, close: canClose, pv: prev, nx: next, pos: i });
        i = j; textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // GFM extended autolink (www., http://, email) — only when not inLink
    // (first letter may be upper or lower case: Https://, WWW., etc.)
    if (!st.inLink && (c === 119 || c === 87 || c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 77 || c === 120 || c === 88)) {
      const u = matchGfmUrl(src, i);
      if (u) {
        if (u.www) {
          const prev = i === 0 ? '' : src[i - 1];
          if (!(prev === '' || isSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(')) {
            i++;
            continue;
          }
        }
        flushText(i);
        nodes.push({ k: 3, href: u.href, title: '', label: u.text, img: false, auto: true, labelNodes: null });
        i = u.next; textStart = i;
        continue;
      }
    }
    // bare email autolink: can start with any email char at a word boundary
    if (!st.inLink && isEmailCharCode(c) && (i === 0 || !isEmailCharCode(src.charCodeAt(i - 1)))) {
      // A trailing `_` suppresses the autolink (gfm-632/633) — unless it
      // is an emphasis closer, i.e. an open `_` delimiter precedes the
      // email in this inline run (marked's emStrong extracts `__...__`
      // before the email is tokenized, so `x@y.z__` is an email there).
      let openUnd = false;
      for (let q = nodes.length - 1; q >= 0; q--) {
        const nd = nodes[q];
        if (nd.k === 1 && nd.ch === '_' && nd.open) { openUnd = true; break; }
      }
      const em = matchEmail(src, i, openUnd);
      if (em) {
        flushText(i);
        nodes.push({ k: 3, href: 'mailto:' + em.text, title: '', label: em.text, img: false, auto: true, labelNodes: null });
        i = em.next; textStart = i;
        continue;
      }
    }
    // hard break: 2+ spaces + newline
    if (c === 32) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < n && src.charCodeAt(j) === 10) {
        let k = j + 1;
        while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
        if (k < n && src.charCodeAt(k) !== 10) {
          flushText(i);
          nodes.push({ k: 5 });
          i = k; textStart = i;
          continue;
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  flushText(n);
  // Hide delimiter runs covered by an emStrong mask (a link, code span,
  // or HTML span that blockSkip finds in the masked source) from emphasis
  // resolution; they render literally.
  if (src.indexOf('[') !== -1) {
    const ranges = computeMaskedRanges(src, links);
    if (ranges.length) {
      for (const node of nodes) {
        if (node.k !== 1) continue;
        for (let r = 0; r < ranges.length; r++) {
          if (node.pos >= ranges[r][0] && node.pos < ranges[r][1]) { node.masked = true; break; }
        }
      }
    }
  }
  return { nodes, hasLink };
}

// Match an inline HTML tag / comment / PI / declaration / CDATA at src[i] ('<').
function matchInlineTag(src, i) {
  const n = src.length;
  const sub = src.slice(i, Math.min(n, i + 200));
  if (sub.startsWith('<!--')) {
    // `<!-->` and `<!--->` are complete empty comments (abrupt closing);
    // they do not extend to a later `-->`
    if (src[i + 4] === '>') return { text: '<!-->', next: i + 5 };
    if (src[i + 4] === '-' && src[i + 5] === '>') return { text: '<!--->', next: i + 6 };
    const end = src.indexOf('-->', i + 4);
    if (end !== -1) return { text: src.slice(i, end + 3), next: end + 3 };
    return { text: src.slice(i), next: n };
  }
  if (sub.startsWith('<?')) {
    const end = src.indexOf('?>', i + 2);
    if (end !== -1) return { text: src.slice(i, end + 2), next: end + 2 };
    return null;
  }
  if (sub.startsWith('<!') && !sub.startsWith('<![CDATA[')) {
    let j = i + 2;
    if (j < n && /[a-zA-Z]/.test(src[j])) {
      const end = src.indexOf('>', j);
      if (end !== -1) return { text: src.slice(i, end + 1), next: end + 1 };
    }
    return null;
  }
  if (sub.startsWith('<![CDATA[')) {
    const end = src.indexOf(']]>', i + 9);
    if (end !== -1) return { text: src.slice(i, end + 3), next: end + 3 };
    return null;
  }
  if (sub.startsWith('</')) {
    const m = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(sub);
    if (m) return { text: m[0], next: i + m[0].length };
    return null;
  }
  const m = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/.exec(sub);
  if (m) return { text: m[0], next: i + m[0].length };
  return null;
}

// Match <scheme:...> or <email> autolink at src[i] ('<').
function matchAutolink(src, i) {
  const n = src.length;
  if (i + 1 >= n) return null;
  const end = src.indexOf('>', i + 1);
  if (end === -1 || end - i > 500) return null;
  const inner = src.slice(i + 1, end);
  if (inner.length === 0 || /[\s<>]/.test(inner)) return null;
  const sm = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^\s\x00-\x1f<>]*)$/.exec(inner);
  if (sm) return { text: inner, href: inner, next: end + 1 };
  if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(inner)) {
    return { text: inner, href: 'mailto:' + inner, next: end + 1 };
  }
  return null;
}

// Try to parse an inline link starting at src[after] === '(' with label `label`.
function tryInlineLink(src, after, label, isImg, links, st) {
  const n = src.length;
  let i = after + 1;
  i = skipLinkWs(src, i);
  if (i >= n) return null;
  const d = parseDest(src, i);
  if (!d) return null;
  let href = d.href;
  let title = '';
  let j = d.next;
  let k = skipLinkWs(src, j);
  if (k < n && src.charCodeAt(k) !== 41) {
    const t = parseTitle(src, k);
    if (!t) return null;
    title = t.title;
    k = t.next;
    k = skipLinkWs(src, k);
  }
  if (k >= n || src.charCodeAt(k) !== 41) return null;
  const next = k + 1;
  href = href.replace(/\\([\p{P}\p{S}])/gu, '$1');
  title = title.replace(/\\([\p{P}\p{S}])/gu, '$1');
  // Scan the label once; its nodes are stored for rendering. A link inside
  // the label abandons the outer link (unless this is an image).
  const savedInLink = st.inLink;
  const savedInRawBlock = st.inRawBlock;
  const labelSt = { inLink: true, inRawBlock: st.inRawBlock };
  const inner = scanInline(label, links, labelSt);
  resolveEmphasis(inner.nodes);
  if (!isImg && inner.hasLink) {
    st.inRawBlock = savedInRawBlock;
    st.inLink = savedInLink;
    return null;
  }
  st.inLink = savedInLink;
  st.inRawBlock = labelSt.inRawBlock;
  const node = { k: 3, href, title, label, img: isImg, auto: false, labelNodes: inner.nodes };
  return { node, next };
}

// Try a reference link: [label][ref], [label][], or [label].
function tryRefLink(src, close, label, isImg, links, st) {
  const n = src.length;
  let ref = null, next = -1;
  // collapsed reference [foo][] must be checked before the general [ref] case
  if (close + 2 < n && src.charCodeAt(close + 1) === 91 && src.charCodeAt(close + 2) === 93) {
    ref = label;
    next = close + 3;
  } else if (close + 1 < n && src.charCodeAt(close + 1) === 91) {
    const close2 = findLabelEnd(src, close + 1);
    if (close2 === -1) return null;
    ref = src.slice(close + 2, close2);
    next = close2 + 1;
  } else {
    ref = label;
    next = close + 1;
  }
  if (ref === null || ref.length === 0) return null;
  if (ref.trim().length === 0 || ref.length > 999) return null;
  const def = links[normLabel(ref)];
  if (!def) return null;
  const savedInLink = st.inLink;
  const savedInRawBlock = st.inRawBlock;
  const labelSt = { inLink: true, inRawBlock: st.inRawBlock };
  const inner = scanInline(label, links, labelSt);
  resolveEmphasis(inner.nodes);
  if (!isImg && inner.hasLink) {
    st.inRawBlock = savedInRawBlock;
    st.inLink = savedInLink;
    return null;
  }
  st.inLink = savedInLink;
  st.inRawBlock = labelSt.inRawBlock;
  const node = { k: 3, href: def.href, title: def.title || '', label, img: isImg, auto: false, labelNodes: inner.nodes };
  return { node, next };
}

// GFM extended autolink: www., http://, https://, ftp://, mailto:, xmpp: at i.
function matchGfmUrl(src, i) {
  const rest = src.slice(i);
  // marked's scheme is case-insensitive: [hH][tT][tT][pP][sS]?|[fF][tT][pP]
  let m = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/[^\s<]*/.exec(rest);
  if (m) {
    const text = backpedalUrl(m[0]);
    if (text.length === 0) return null;
    return { text, href: text, next: i + text.length, www: false };
  }
  m = /^www\.[^\s<]*/.exec(rest);
  if (m) {
    const text = backpedalUrl(m[0]);
    if (text.length === 0) return null;
    return { text, href: 'http://' + text, next: i + text.length, www: true };
  }
  // xmpp may carry a single /resource segment after the domain
  m = /^xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[^\s</]*)?/.exec(rest);
  if (m) {
    const text = backpedalUrl(m[0]);
    if (text.length === 0) return null;
    return { text, href: text, next: i + text.length, www: false };
  }
  m = /^mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/.exec(rest);
  if (m) return { text: m[0], href: m[0], next: i + m[0].length, www: false };
  return null;
}

// Trim trailing punctuation from a GFM autolink the way marked's backpedal does.
function backpedalUrl(s) {
  // marked applies the backpedal repeatedly until the result stops changing
  const re = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
  let prev = s, cur = s;
  do {
    prev = cur;
    const m = re.exec(cur);
    cur = m ? m[0] : '';
  } while (cur !== prev);
  return cur;
}

// Bare email autolink at i (no scheme).
// Marked's email regex ends with (?![\w-]): a trailing `-` or lone `_`
// suppresses the autolink (gfm-632/633). But when the trailing `_` run
// is an emphasis closer (an open `_` delimiter precedes the email),
// marked's emStrong extracts the `__...__` span before the email is
// tokenized, so the email is matched in full. `allowUnd` selects the
// greedy match (no lookahead) for that case.
function matchEmail(src, i, allowUnd) {
  if (allowUnd) {
    const m = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/.exec(src.slice(i));
    if (!m) return null;
    return { text: m[0], next: i + m[0].length };
  }
  const m = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/.exec(src.slice(i));
  if (!m) return null;
  return { text: m[0], next: i + m[0].length };
}

// ---------------------------------------------------------------------------
// Emphasis resolution (CommonMark delimiter-stack algorithm)
// ---------------------------------------------------------------------------

// Resolve delimiter runs (k:1) into em (7), strong (8), del (9) nodes.
// Mutates `nodes` in place.
// ---------------------------------------------------------------------------
// Emphasis resolution
// ---------------------------------------------------------------------------

// First/last source character of a node list, used to recompute the
// flanking of a delimiter run that ends up at the edge of an emphasis
// span's re-tokenized inner text.
function firstCharOfNodes(list) {
  for (const node of list) {
    if (node.k === 0) { if (node.s.length) return node.s[0]; }
    else if (node.k === 1) return node.ch;
    else if (node.k === 2) return '`';
    else if (node.k === 3) {
      if (node.auto) return node.label[0];
      return node.img ? '!' : '[';
    }
    else if (node.k === 4) return '<';
    else if (node.k === 5) return '\n';
    else if (node.k === 6) return node.s;
    else return node.ch || '';
  }
  return '';
}

function lastCharOfNodes(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const node = list[i];
    if (node.k === 0) { if (node.s.length) return node.s[node.s.length - 1]; }
    else if (node.k === 1) return node.ch;
    else if (node.k === 2) return '`';
    else if (node.k === 3) {
      if (node.auto) return node.label[node.label.length - 1];
      return ')';
    }
    else if (node.k === 4) return '>';
    else if (node.k === 5) return '\n';
    else if (node.k === 6) return node.s;
    else return node.ch || '';
  }
  return '';
}

// Open/close flags for a delimiter run from its immediate neighbours,
// mirroring the scanner's flankInfo rules.
function delimFlags(ch, pv, nx) {
  const fl = flankInfo(pv, nx);
  if (ch === '*') return { open: fl.left, close: fl.right };
  if (ch === '_') {
    return {
      open: fl.left && (!fl.right || fl.prevIsPunct),
      close: fl.right && (!fl.left || fl.nextIsPunct),
    };
  }
  return { open: fl.left, close: fl.right };
}

// Recompute a delimiter node's open/close flags for new neighbours.
function reflag(node, pv, nx) {
  const f = delimFlags(node.ch, pv, nx);
  node.pv = pv; node.nx = nx;
  node.open = f.open; node.close = f.close;
}

// The emStrong RDelim's leading skip: a `__…*…__` span (for a `*`
// opener) or a `**…_…**` span (for a `_` opener) at the start of the
// scan region hides the single inner delimiter from this opener's
// scan. Returns the index of the hidden delimiter node, or -1.
function findRDelimSkip(nodes, start, ch) {
  const other = ch === '*' ? '_' : '*';
  const isDelim = (N) => N.k === 1 && !N.masked && (N.ch === '*' || N.ch === '_');
  let j = start;
  while (j < nodes.length && !isDelim(nodes[j])) j++;
  if (j >= nodes.length) return -1;
  let N = nodes[j];
  if (!(N.k === 1 && !N.masked && N.ch === other && N.n === 2)) return -1;
  j++;
  while (j < nodes.length && !isDelim(nodes[j])) j++;
  if (j >= nodes.length) return -1;
  N = nodes[j];
  if (!(N.k === 1 && !N.masked && N.ch === ch && N.n === 1)) return -1;
  const innerIdx = j;
  j++;
  while (j < nodes.length && !isDelim(nodes[j])) j++;
  if (j >= nodes.length) return -1;
  N = nodes[j];
  if (!(N.k === 1 && !N.masked && N.ch === other && N.n === 2)) return -1;
  return innerIdx;
}

// Mirror of marked's emStrong for '*' and '_' runs. For each opener in
// document order, scan forward over same-char delimiter runs, keeping
// m (unmatched openers) and f (rule-of-3-skipped closers); the first
// closer that drives m to zero (or below) caps the span, and its run is
// capped to b' = min(b, b + m + f). Unused delimiters of the opener and
// of the closer stay INSIDE the span and are re-resolved as part of its
// inner text; any remainder of the closer run stays outside and is
// re-processed as a fresh opener. Masked runs are invisible here.
function resolveEmStarUnd(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const O = nodes[i];
    if (O.k !== 1 || O.masked || (O.ch !== '*' && O.ch !== '_') || !O.open) { i++; continue; }
    const ch = O.ch;
    const k = O.n;
    const y = O.yN !== undefined ? O.yN : k;
    const o = O.pv === ch;
    const R = O.close;
    const skipIdx = findRDelimSkip(nodes, i + 1, ch);
    let m = k, f = 0;
    let closerIdx = -1, bPrime = 0;
    for (let j = i + 1; j < nodes.length; j++) {
      const C = nodes[j];
      if (C.k !== 1 || C.masked || C.ch !== ch) continue;
      if (j === skipIdx) continue; // hidden by the leading RDelim skip
      const both = C.open && C.close;
      if (C.open && !C.close) { m += C.n; continue; } // open-only
      if (both || R) {
        if (o && both) break; // no match for this opener
        if (y % 3 !== 0 && (y + C.n) % 3 === 0) { f += C.n; continue; }
      }
      m -= C.n;
      if (m > 0) continue;
      bPrime = Math.min(C.n, C.n + m + f);
      closerIdx = j;
      break;
    }
    if (closerIdx === -1) {
      // No closer: the first delimiter of the run is literal text and
      // the rest of the run is retried as a fresh opener (marked
      // re-scans from the next character after a failed emStrong). The
      // retried run keeps the original run length for the rule of
      // three, and its previous character is the delimiter itself.
      if (O.n > 1) {
        const origN = O.yN !== undefined ? O.yN : O.n;
        nodes.splice(i, 0, { k: 0, s: ch });
        O.n -= 1;
        if (O.pos !== undefined) O.pos += 1;
        O.yN = origN;
        const fl = delimFlags(ch, ch, O.nx);
        O.pv = ch; O.open = fl.open; O.close = fl.close;
        i = i + 1; // O moved to i+1; retry it there
        continue;
      }
      i++;
      continue;
    }
    const C = nodes[closerIdx];
    const take = (Math.min(k, bPrime) % 2 === 1) ? 1 : 2;
    const kind = take === 1 ? 7 : 8;
    const leftOpen = k - take;
    const leftClose = bPrime - take;
    const restClose = C.n - bPrime;
    // Inner text: the nodes between the opener and the closer.
    const inner = nodes.slice(i + 1, closerIdx);
    const innerFirst = firstCharOfNodes(inner);
    const innerLast = lastCharOfNodes(inner);
    const openNx = innerFirst !== '' ? innerFirst : (leftClose > 0 ? ch : '');
    const closePv = innerLast !== '' ? innerLast : (leftOpen > 0 ? ch : '');
    const children = [];
    if (leftOpen > 0) {
      const fl = delimFlags(ch, '', openNx);
      children.push({ k: 1, ch, n: leftOpen, open: fl.open, close: fl.close, pv: '', nx: openNx, pos: O.pos });
    }
    // A delimiter at the edge of the original inner text now sits next
    // to nothing on that side (no leftover run there).
    if (inner.length) {
      if (!leftOpen) {
        const first = inner[0];
        if (first.k === 1 && !first.masked) reflag(first, '', first.nx);
      }
      if (!leftClose) {
        const last = inner[inner.length - 1];
        if (last.k === 1 && !last.masked) reflag(last, last.pv, '');
      }
    }
    for (const node of inner) children.push(node);
    if (leftClose > 0) {
      const fl = delimFlags(ch, closePv, '');
      children.push({ k: 1, ch, n: leftClose, open: fl.open, close: fl.close, pv: closePv, nx: '', pos: C.pos });
    }
    const wrapped = { k: kind, c: children, ch };
    const replacement = [wrapped];
    if (restClose > 0) {
      // The remainder of the closer run stays outside, as a fresh
      // opener: it behaves like a run whose previous character is the
      // delimiter itself, and keeps the original run length for the
      // rule of three.
      const rest = { k: 1, ch, n: restClose, pv: ch, nx: C.nx, pos: C.pos, yN: C.n };
      const fl = delimFlags(ch, ch, C.nx);
      rest.open = fl.open; rest.close = fl.close;
      replacement.push(rest);
    }
    nodes.splice(i, closerIdx - i + 1, ...replacement);
    // Resolve the span's inner text, then continue with the node after
    // the span (a remaining closer, if any, is re-processed as an
    // opener).
    resolveEmphasis(wrapped.c);
    i = i + 1;
  }
  return nodes;
}

// Strikethrough ('~~' / '~') resolution. A closer must have the same
// run length as its opener; open-only runs add to the pending count and
// the first closer that brings it to zero wins. No rule of three, no
// leftovers: opener and closer are consumed in full.
function resolveDel(nodes) {
  const stack = [];
  for (let idx = 0; idx < nodes.length; idx++) {
    const D = nodes[idx];
    if (D.k !== 1 || D.ch !== '~' || D.masked) continue;
    if (D.close) {
      let matchIdx = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        const O = stack[s];
        if (O.ch !== '~' || O.n !== D.n) continue;
        matchIdx = s;
        break;
      }
      if (matchIdx !== -1) {
        const O = stack[matchIdx];
        const oi = nodes.indexOf(O);
        const di = nodes.indexOf(D);
        const wrapped = { k: 9, c: nodes.slice(oi + 1, di), ch: '~' };
        nodes.splice(oi, di - oi, wrapped);
        stack.splice(matchIdx, stack.length - matchIdx);
        resolveEmphasis(wrapped.c);
        const di2 = nodes.indexOf(D);
        nodes.splice(di2, 1);
        idx = di2 - 1;
        continue;
      }
      if (D.open) stack.push(D);
    } else if (D.open) {
      stack.push(D);
    }
  }
  return nodes;
}

function resolveEmphasis(nodes) {
  resolveEmStarUnd(nodes);
  resolveDel(nodes);
  return nodes;
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

// Render scanned nodes to HTML.
function renderInline(nodes, links) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    switch (node.k) {
      case 0:
        out += node.raw ? node.s : escText(decodeNumRefs(node.s));
        break;
      case 1:
        out += node.ch.repeat(node.n);
        break;
      case 2:
        out += '<code>' + escAll(node.s) + '</code>';
        break;
      case 3:
        out += renderLink(node, links);
        break;
      case 4:
        out += node.s;
        break;
      case 5:
        out += '<br>';
        break;
      case 6:
        out += escText(node.s);
        break;
      case 7:
        out += '<em>' + renderInline(node.c, links) + '</em>';
        break;
      case 8:
        out += '<strong>' + renderInline(node.c, links) + '</strong>';
        break;
      case 9:
        out += '<del>' + renderInline(node.c, links) + '</del>';
        break;
    }
  }
  return out;
}

// Render a link/image node.
function renderLink(node, links) {
  if (node.img) {
    const alt = node.labelNodes ? textContent(node.labelNodes) : node.label;
    const r = cleanUrl(node.href);
    if (r === null) return escText(alt);
    let out = '<img src="' + escText(r) + '" alt="' + escText(alt) + '"';
    if (node.title) out += ' title="' + escText(node.title) + '"';
    return out + '>';
  }
  if (node.auto) {
    const r = cleanUrl(node.href);
    if (r === null) return escAll(node.label);
    return '<a href="' + escAll(r) + '">' + escAll(node.label) + '</a>';
  }
  const inner = renderInline(node.labelNodes || [], links);
  const r = cleanUrl(node.href);
  if (r === null) return inner;
  let out = '<a href="' + escText(r) + '"';
  if (node.title) out += ' title="' + escText(node.title) + '"';
  return out + '>' + inner + '</a>';
}

// Flatten nodes to plain text (for image alt attributes), the way marked's
// textRenderer does: emphasis/links recurse, code/html return their text,
// br returns '', escape returns the char.
function textContent(nodes) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    switch (node.k) {
      case 0:
        out += node.raw ? node.s : decodeNumRefs(node.s);
        break;
      case 1:
        out += node.ch.repeat(node.n);
        break;
      case 2:
        out += node.s;
        break;
      case 3:
        if (node.auto) out += node.label;
        else out += node.labelNodes ? textContent(node.labelNodes) : node.label;
        break;
      case 4:
        out += node.s;
        break;
      case 5:
        break;
      case 6:
        out += node.s;
        break;
      case 7:
      case 8:
      case 9:
        out += textContent(node.c);
        break;
    }
  }
  return out;
}

// Parse an inline string to HTML (scan, resolve emphasis, render).
// inLink persists across blocks within one parse() (an unclosed <a> tag
// suppresses autolinks in later paragraphs); inRawBlock resets per block.
let docInLink = false;

function inlineToHtml(src, links) {
  const st = { inLink: docInLink, inRawBlock: false };
  const { nodes } = scanInline(src, links, st);
  resolveEmphasis(nodes);
  docInLink = st.inLink;
  return renderInline(nodes, links);
}

// ---------------------------------------------------------------------------
// Block parsing (line based, recursive)
// ---------------------------------------------------------------------------
// Token types:
//  code {text, lang} | heading {depth, text} | hr | blockquote {tokens}
//  list {ordered, start, items:[{tokens, checked}]} | html {text}
//  table {header:[{text,align}], rows:[[{text}]]} | paragraph {text} | text {text}
// `text` fields hold raw inline source; inline parsing happens at render
// time, after all link reference definitions have been collected.

// Column width of the leading whitespace of a line (tab = next multiple of 4).
function lineIndent(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove `cols` columns of leading whitespace, turning a straddling tab into
// the spaces that remain. Returns the rest of the line.
// Remove up to `cols` leading whitespace characters (space or tab, each
// counting as one) — marked's fenced-code indent stripping for backtick
// fences. Unlike stripIndent, a tab does not expand to the next tab stop.
function stripFenceIndent(line, cols) {
  let i = 0;
  while (i < line.length && i < cols && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return line.slice(i);
}

function stripIndent(line, cols) {
  let col = 0, i = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const adv = 4 - (col % 4);
      if (col + adv > cols) return ' '.repeat(col + adv - cols) + line.slice(i + 1);
      col += adv; i++;
    } else break;
  }
  return line.slice(i);
}

// Is the line blank (only spaces/tabs)?
function isBlank(line) { return line.trim() === ''; }

// ATX heading: 0-3 spaces, 1-6 #, then space/tab or end. Returns {depth, text} or null.
function matchAtx(line) {
  const ind = lineIndent(line);
  if (ind > 3) return null;
  let i = ind;
  // count #s (line has tabs expanded only for indent; use raw chars after indent)
  const rest = stripIndent(line, ind);
  let d = 0;
  while (d < rest.length && rest.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d < rest.length && rest.charCodeAt(d) !== 32 && rest.charCodeAt(d) !== 9) return null;
  let text = rest.slice(d).trim();
  // Remove a closing sequence of #s, but only when it is preceded by a
  // space (or the whole text is #s).
  if (/#$/.test(text)) {
    const stripped = text.replace(/#+$/, '');
    if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { depth: d, text };
}

// Thematic break: 0-3 spaces, 3+ of the same -, _, * with only spaces/tabs between.
function matchHr(line) {
  const ind = lineIndent(line);
  if (ind > 3) return false;
  const rest = stripIndent(line, ind).trim();
  if (rest.length < 3) return false;
  const c = rest.charCodeAt(0);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest.charCodeAt(i);
    if (ch !== c && ch !== 32 && ch !== 9) return false;
  }
  let count = 0;
  for (let i = 0; i < rest.length; i++) if (rest.charCodeAt(i) === c) count++;
  return count >= 3;
}

// Setext underline: 0-3 spaces, 1+ = or - with NO spaces in the middle,
// then only spaces/tabs. Returns 1 (=) or 2 (-) or 0.
function matchSetext(line) {
  const ind = lineIndent(line);
  if (ind > 3) return 0;
  const rest = stripIndent(line, ind).trim();
  if (rest.length === 0) return 0;
  if (/^=+$/.test(rest)) return 1;
  if (/^-+$/.test(rest)) return 2;
  return 0;
}

// Fenced code opening: 0-3 spaces, 3+ ` or ~. Returns {ch, len, info, ind} or null.
function matchFence(line) {
  const ind = lineIndent(line);
  if (ind > 3) return null;
  const rest = stripIndent(line, ind);
  if (rest.length < 3) return null;
  const c = rest.charCodeAt(0);
  if (c !== 96 && c !== 126) return null;
  let len = 0;
  while (len < rest.length && rest.charCodeAt(len) === c) len++;
  if (len < 3) return null;
  const info = rest.slice(len);
  if (c === 96 && info.includes('`')) return null;
  return { ch: c === 96 ? '`' : '~', len, info: info.trim(), ind };
}

// Expand leading tabs of `line` to spaces, where the line's first character
// is at absolute column baseCol. Non-leading tabs are left alone.
function expandLeadingTabs(line, baseCol) {
  let out = '';
  let col = baseCol;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) {
      const adv = 4 - (col % 4);
      out += ' '.repeat(adv);
      col += adv; i++;
    } else break;
  }
  return out + line.slice(i);
}

// Blockquote marker: 0-3 spaces + '>'. Returns the content after the marker,
// with the whitespace after '>' expanded to spaces (from the column after
// the marker) and one column dropped (the single space after the marker).
// Mirrors marked: b + J(m, b.length), then '>' + one space/tab removed.
function matchBQ(line) {
  const ind = lineIndent(line);
  if (ind > 3) return null;
  const rest = stripIndent(line, ind);
  if (rest.charCodeAt(0) !== 62) return null; // >
  const after = rest.slice(1);
  let i = 0;
  while (i < after.length && (after.charCodeAt(i) === 32 || after.charCodeAt(i) === 9)) i++;
  if (i === 0) return after;
  const expanded = expandLeadingTabs(after.slice(0, i), ind + 1);
  return expanded.slice(1) + after.slice(i);
}

// List marker: 0-3 spaces + bullet (-,+,*) or ordered (1-9 digits + . or ))
// followed by 1+ spaces/tabs (or end of line). Returns {ordered, start, markerLen, contentIndent, content} or null.
function matchListMarker(line) {
  const ind = lineIndent(line);
  if (ind > 3) return null;
  const rest = stripIndent(line, ind);
  if (rest.length === 0) return null;
  const c0 = rest.charCodeAt(0);
  let ordered = false, start = 0, mlen = 0;
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    mlen = 1;
  } else if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < rest.length && rest.charCodeAt(j) >= 48 && rest.charCodeAt(j) <= 57) j++;
    if (j === 0 || j > 9) return null;
    const d = rest.charCodeAt(j);
    if (d !== 46 && d !== 41) return null; // . or )
    ordered = true;
    start = parseInt(rest.slice(0, j), 10);
    mlen = j + 1;
  } else return null;
  // after the marker: 1+ spaces/tabs, or end of line
  let s = rest.slice(mlen);
  if (s.length === 0) {
    return { ordered, start, markerLen: mlen, contentIndent: ind + mlen + 1, content: '', empty: true };
  }
  if (s.charCodeAt(0) !== 32 && s.charCodeAt(0) !== 9) return null;
  // Expand the leading whitespace of the content starting at the column
  // where the marker ends (marked's J(v, b)); R = leading-space count,
  // capped to 1 when > 4 (indented code); content = m.slice(R).
  const baseCol = ind + mlen;
  const m = expandLeadingTabs(s, baseCol);
  if (m.trim() === '') {
    return { ordered, start, markerLen: mlen, contentIndent: baseCol + 1, content: '', empty: true };
  }
  let R = 0;
  while (R < m.length && m.charCodeAt(R) === 32) R++;
  if (R > 4) R = 1;
  return { ordered, start, markerLen: mlen, contentIndent: R + baseCol, content: m.slice(R), empty: false };
}

// HTML block start (CommonMark types 1-7). Returns the type (1-7) or 0.
// `line` is the raw line (indent already known to be 0-3).
function htmlBlockType(line) {
  const rest = stripIndent(line, lineIndent(line));
  if (!rest.startsWith('<')) return 0;
  const low = rest.toLowerCase();
  if (/^<(script|pre|style|textarea)(?:[\s>]|$)/.test(low)) return 1;
  if (low.startsWith('<!--')) return 2;
  if (low.startsWith('<?')) return 3;
  if (/^<![a-z]/i.test(rest)) return 4;
  if (low.startsWith('<![cdata[')) return 5;
  // type 6: block-level tag
  const m6 = /^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([\s/>]|$)/i.exec(rest);
  if (m6) return 6;
  // type 7: a line that is exactly one complete open or closing tag
  // (nothing else on the line), for a tag that is not a block-level tag.
  const trimmed = rest.trim();
  const tagM = matchInlineTag(rest, 0);
  if (tagM && rest.slice(tagM.next).trim() === '') {
    const tagText = tagM.text;
    // must be a tag (not a comment/PI/etc. — those are types 2-5) and not a
    // block-level tag (type 6). A line with content after the open tag
    // (e.g. <del>*foo*</del>) is not type 7.
    if (/^<\/?[a-zA-Z]/.test(tagText)) return 7;
  }
  return 0;
}

// Link reference definition starting at lines[i]. Returns {href, title, next} (next = index after the def) or null.
// The def may span two lines (title on the next line).
// Link-reference definition regex (mirrors marked's `def` rule):
// label may span lines, dest may be on the next line, title may be on the
// same or the next line and may span lines (single-quoted, no blank line).
// A title must be separated from the dest by whitespace — otherwise the
// whole thing is not a definition.
const DEF_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)';
const DEF_RE = new RegExp(
  '^ {0,3}\\[' + '(' + DEF_LABEL + ')' + '\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)' +
  '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + DEF_TITLE + '))? *(?:\\n+|$)'
);
const UNESC = /\\([\p{P}\p{S}])/gu;

function matchDef(lines, i, links) {
  // Join this line and the following lines (up to a blank line, max 8) so
  // a multi-line definition can be matched as one unit.
  let src = '';
  let count = 0;
  for (let j = i; j < lines.length && count < 8; j++, count++) {
    if (isBlank(lines[j])) break;
    src += lines[j] + '\n';
  }
  if (src === '') return null;
  const m = DEF_RE.exec(src);
  if (!m) return null;
  const label = m[1];
  let href = m[2];
  if (href.charCodeAt(0) === 60) href = href.slice(1, -1); // <...>
  let title = '';
  if (m[3] !== undefined) title = m[3].slice(1, -1);
  href = href.replace(UNESC, '$1');
  title = title.replace(UNESC, '$1');
  const key = normLabel(label);
  if (!Object.hasOwn(links, key)) links[key] = { href, title };
  // lines consumed = lines spanned by the match, excluding trailing newlines
  const core = m[0].replace(/\n+$/, '');
  const span = core.split('\n').length;
  return { next: i + span };
}

// Table delimiter line: 0-3 spaces, cells of - with optional : alignment, separated by |.
// Returns the align array (one per column) or null.
function matchTableDelim(line) {
  const ind = lineIndent(line);
  if (ind > 3) return null;
  const rest = stripIndent(line, ind).trim();
  if (!rest.includes('-')) return null;
  // must be only |, :, -, spaces
  if (!/^[|:\- ]+$/.test(rest)) return null;
  const cells = splitCells(rest, 0);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
    else if (c.endsWith(':')) aligns.push('right');
    else if (c.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// Main block parser: parse lines[start..end) into tokens. `links` is mutated.
function lexBlocks(lines, start, end, links, top, inner) {
  const tokens = [];
  let i = start;
  let blankBefore = false;
  let loose = false;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { blankBefore = true; i++; continue; }
    // a blank line before this block, with a block already emitted, means
    // two top-level blocks are separated by a blank line (loose)
    if (blankBefore && tokens.length > 0) loose = true;
    blankBefore = false;
    const ind = lineIndent(line);
    // --- indented code (4+ spaces), only when not in a paragraph (we are at a block start) ---
    if (ind >= 4) {
      const codeLines = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        if (isBlank(l)) {
          // blank line: include only if a following indented line exists;
          // keep the line's content after stripping 4 columns
          let k = j + 1;
          while (k < end && isBlank(lines[k])) k++;
          if (k < end && lineIndent(lines[k]) >= 4) {
            for (let b = j; b < k; b++) codeLines.push(stripIndent(lines[b], 4));
            j = k;
            continue;
          }
          break;
        }
        if (lineIndent(l) >= 4) {
          codeLines.push(stripIndent(l, 4));
          j++;
        } else break;
      }
      tokens.push({ t: 'code', text: codeLines.join('\n'), lang: '' });
      i = j;
      continue;
    }
    // --- fenced code ---
    const fence = matchFence(line);
    if (fence) {
      const codeLines = [];
      let j = i + 1;
      while (j < end) {
        const l = lines[j];
        const f2 = matchFence(l);
        if (f2 && f2.ch === fence.ch && f2.len >= fence.len && f2.info.trim() === '') break;
        // marked strips the fence indent from content lines for backtick
        // fences, but NOT for tilde fences (the indent is kept). For
        // backtick fences the indent is removed as up to `ind` leading
        // whitespace CHARACTERS (a tab counts as one, not as columns to
        // the next tab stop) — so `\tfoo` in a 3-indent fence is `foo`,
        // not ` foo`.
        codeLines.push(fence.ch === '`' ? stripFenceIndent(l, fence.ind) : l);
        j++;
      }
      tokens.push({ t: 'code', text: codeLines.join('\n'), lang: fence.info });
      i = (j < end) ? j + 1 : j;
      continue;
    }
    // --- ATX heading ---
    const atx = matchAtx(line);
    if (atx) {
      tokens.push({ t: 'heading', depth: atx.depth, text: atx.text });
      i++;
      continue;
    }
    // --- hr ---
    if (matchHr(line)) {
      tokens.push({ t: 'hr' });
      i++;
      continue;
    }
    // --- blockquote ---
    if (matchBQ(line) !== null) {
      const { tokens: bqTokens, next } = parseBlockquote(lines, i, end, links);
      tokens.push({ t: 'blockquote', tokens: bqTokens });
      i = next;
      continue;
    }
    // --- list ---
    const lm = matchListMarker(line);
    if (lm) {
      const { tokens: listTok, next, trailingBlanks } = parseList(lines, i, end, links, top);
      tokens.push(listTok);
      // blank lines after the list (swallowed as trailing blanks) separate
      // it from the next block: mark looseness for the next block
      if (trailingBlanks > 0 && next < end) blankBefore = true;
      i = next;
      continue;
    }
    // --- HTML block ---
    if (ind <= 3) {
      const ht = htmlBlockType(line);
      if (ht > 0) {
        const { text, next } = parseHtmlBlock(lines, i, end, ht);
        tokens.push({ t: 'html', text });
        i = next;
        continue;
      }
    }
    // --- link reference definition ---
    if (ind <= 3 && line.trimStart().startsWith('[')) {
      const def = matchDef(lines, i, links);
      if (def) { i = def.next; continue; }
    }
    // --- table (GFM): header line + delimiter line ---
    if (ind <= 3 && line.includes('|')) {
      const tbl = matchTable(lines, i, end, links);
      if (tbl) {
        tokens.push(tbl.token);
        i = tbl.next;
        continue;
      }
    }
    // --- paragraph (with setext heading and text fallback) ---
    {
      const { token, next } = parseParagraph(lines, i, end, links, top, inner);
      tokens.push(token);
      i = next;
      continue;
    }
  }
  tokens.loose = loose;
  return tokens;
}

// Is this stripped content line a paragraph line (keeps a paragraph open)?
function contentIsParaLine(s) {
  if (isBlank(s)) return false;
  if (matchAtx(s) || matchFence(s) || matchHr(s)) return false;
  if (matchListMarker(s)) return false;
  if (matchSetext(s)) return false;
  if (matchBQ(s) !== null) return false;
  const ind = lineIndent(s);
  if (ind >= 4) return false;
  if (ind <= 3) {
    const ht = htmlBlockType(s);
    if (ht >= 1 && ht <= 6) return false;
  }
  return true;
}

// Does a line, as a block, end in an open paragraph? Unwraps blockquote
// and list markers to the innermost content (e.g. `1. > Blockquote`
// ends in the paragraph `Blockquote`, so a lazy line may continue it).
function endsInPara(s) {
  let cur = s;
  for (let depth = 0; depth < 8; depth++) {
    const bq = matchBQ(cur);
    if (bq !== null) { cur = bq; continue; }
    const lm = matchListMarker(cur);
    if (lm) { cur = lm.content; continue; }
    return contentIsParaLine(cur);
  }
  return false;
}

// Parse a blockquote starting at lines[i]. Returns {tokens, next}.
function parseBlockquote(lines, i, end, links) {
  const content = [];
  let j = i;
  let inPara = false;
  // Track fenced code inside the quote: a lazy line cannot continue a
  // fenced code block, it ends the blockquote.
  let inFence = false, fenceCh = '', fenceLen = 0;
  const trackFence = (bq) => {
    const f = matchFence(bq);
    if (!inFence) {
      if (f) { inFence = true; fenceCh = f.ch; fenceLen = f.len; }
    } else if (f && f.ch === fenceCh && f.len >= fenceLen && f.info === '') {
      inFence = false;
    }
  };
  while (j < end) {
    const line = lines[j];
    const bq = matchBQ(line);
    if (bq !== null) {
      content.push(bq);
      trackFence(bq);
      inPara = !inFence && endsInPara(bq);
      j++;
      continue;
    }
    if (isBlank(line)) break; // a blank line ends the blockquote
    if (inFence) break; // a lazy line cannot continue fenced code
    // Lazy continuation: only a paragraph line can continue lazily.
    // A setext underline of dashes ends the quote (it is an hr outside);
    // a setext underline of equals is kept as text, indented so it does
    // not form a heading. An indented-code line also continues (it merges
    // into the paragraph).
    if (inPara) {
      const se = matchSetext(line);
      if (se === 2) break;
      if (se === 1) {
        content.push('    ' + line.trim());
        inPara = true;
        j++;
        continue;
      }
      if (contentIsParaLine(line) || lineIndent(line) >= 4) {
        // A lazy line is a paragraph continuation, not a new block: join
        // it onto the last content line so it is never re-lexed as a
        // list/heading/etc. An indented lazy line is indented code
        // merging into the paragraph, so strip 4 columns (cm-238:
        // `    - bar` becomes text `- bar`, not a list). Proper `>`
        // lines are pushed separately above and keep their spaces.
        const text = lineIndent(line) >= 4 ? stripIndent(line, 4) : line;
        if (content.length) content[content.length - 1] += '\n' + text;
        else content.push(text);
        inPara = true;
        j++;
        continue;
      }
    }
    break;
  }
  while (content.length && content[content.length - 1] === '') content.pop();
  const tokens = lexBlocks(content, 0, content.length, links, true, true);
  return { tokens, next: j };
}

// Parse an HTML block starting at lines[i] of the given type.
// Returns {text, next}.
function parseHtmlBlock(lines, i, end, type) {
  const out = [];
  let j = i;
  if (type === 1) {
    // script/pre/style/textarea: until the matching close tag
    const m = /^<(script|pre|style|textarea)([\s>]|$)/i.exec(lines[i].trimStart());
    const tag = m ? m[1].toLowerCase() : 'script';
    const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
    while (j < end) {
      out.push(lines[j]);
      if (closeRe.test(lines[j])) { j++; break; }
      j++;
    }
  } else if (type === 2) {
    while (j < end) {
      out.push(lines[j]);
      if (lines[j].includes('-->')) { j++; break; }
      j++;
    }
  } else if (type === 3) {
    while (j < end) {
      out.push(lines[j]);
      if (lines[j].includes('?>')) { j++; break; }
      j++;
    }
  } else if (type === 4) {
    while (j < end) {
      out.push(lines[j]);
      if (lines[j].includes('>')) { j++; break; }
      j++;
    }
  } else if (type === 5) {
    while (j < end) {
      out.push(lines[j]);
      if (lines[j].includes(']]>')) { j++; break; }
      j++;
    }
  } else {
    // types 6 and 7: until a blank line (a whitespace-only line, even a
    // lone tab, ends the block); a trailing whitespace-only line is kept
    // as the block text's last line (its `\t` shows in the output)
    while (j < end && !isBlank(lines[j])) {
      out.push(lines[j]);
      j++;
    }
    if (j < end && lines[j] !== '' && isBlank(lines[j])) {
      out.push(lines[j]);
      j++;
    }
  }
  return { text: htmlBlockText(out, j, lines, end), next: j };
}

// The raw text of an HTML block: the content lines joined by \n, plus the
// newlines that terminate them, trimmed the way marked's ge() does (a single
// trailing newline is kept; a blank line after the block removes it).
function htmlBlockText(contentLines, nextIdx, lines, end) {
  let text = contentLines.join('\n');
  let trailing = 0;
  if (nextIdx < end) trailing = 1;
  else if (end > 0 && lines[end - 1] === '') trailing = 1;
  let blanks = 0;
  let m = nextIdx;
  // only truly empty lines count as blank separators here; a
  // whitespace-only line (e.g. a lone tab) does not strip the newline
  while (m < end && lines[m] === '') {
    if (m === end - 1 && lines[m] === '') break;
    blanks++;
    m++;
  }
  trailing += blanks;
  text += '\n'.repeat(trailing);
  const e = text.split('\n');
  let t = e.length - 1;
  while (t >= 0 && /^\s*$/.test(e[t])) t--;
  if (e.length - t <= 2) return text;
  // At end of input the block's text keeps one trailing newline; when a
  // blank line follows, the trailing newlines are dropped.
  return nextIdx >= end ? e.slice(0, t + 2).join('\n') : e.slice(0, t + 1).join('\n');
}

// Table starting at lines[i] (header) with delimiter at i+1.
// Returns {token, next} or null.
function matchTable(lines, i, end, links) {
  const headerLine = lines[i];
  if (lineIndent(headerLine) > 3) return null;
  if (!headerLine.includes('|')) return null;
  if (i + 1 >= end) return null;
  const aligns = matchTableDelim(lines[i + 1]);
  if (!aligns) return null;
  const count = aligns.length;
  // the header must have the same number of cells as the delimiter row
  const headerCells = splitCells(headerLine);
  if (headerCells.length !== count) return null;
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const l = lines[j];
    // a truly empty line, or a line of only spaces, ends the table; a
    // whitespace-only line holding a TAB is a row of empty cells (marked's
    // table body treats a tab line as content, a spaces-only line as blank)
    if (l === '' || /^[ ]+$/.test(l)) break;
    if (isBlank(l)) {
      // whitespace-only with a tab: a row, unless it is the last line or
      // the next line is a link definition (which ends the table)
      if (j === end - 1) break;
      if (matchDef(lines, j + 1, links)) break;
      rows.push(splitCells(l, count));
      j++;
      continue;
    }
    // a link reference definition ends the table (it is collected as a
    // definition, not a row)
    if (matchDef(lines, j, links)) break;
    if (matchAtx(l) || matchFence(l) || matchHr(l) || matchBQ(l) !== null || matchListMarker(l)) break;
    const ind = lineIndent(l);
    if (ind >= 4) break;
    if (ind <= 3 && htmlBlockType(l) > 0) break;
    rows.push(splitCells(l, count));
    j++;
  }
  const header = headerCells.map((text, idx) => ({ text, align: aligns[idx] }));
  const rowObjs = rows.map(cells => cells.map(text => ({ text })));
  return { token: { t: 'table', header, rows: rowObjs }, next: j };
}

// Does this list marker interrupt a paragraph? Bullet lists (non-empty item)
// and ordered lists starting with 1 (non-empty item) can interrupt.
function listInterrupts(lm) {
  if (lm.content.trim() === '') return false;
  if (!lm.ordered) return true;
  return lm.start === 1;
}

// Parse a paragraph starting at lines[i]. Returns {token, next}.
// A following setext underline turns the whole paragraph into a heading.
// When top is false (inside a list item) the token is a 'text' token.
function parseParagraph(lines, i, end, links, top, inner) {
  const paraLines = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      // a trailing whitespace-only line (e.g. the content of `>  `) is part
      // of the paragraph: it contributes its whitespace to the text
      if (paraLines.length > 0 && line.length > 0 && j === end - 1) {
        paraLines.push(line);
        j++;
      }
      break;
    }
    const se = matchSetext(line);
    if (se > 0 && paraLines.length > 0) {
      // a setext heading: the paragraph text is trimmed
      const text = paraLines.join('\n').trim();
      return { token: { t: 'heading', depth: se, text }, next: j + 1 };
    }
    if (paraLines.length > 0) {
      const ind = lineIndent(line);
      if (matchAtx(line)) break;
      if (matchFence(line)) break;
      if (matchHr(line)) break;
      if (matchBQ(line) !== null) break;
      const lm = matchListMarker(line);
      // A text token (inside a list item) stops at ANY list marker; a
      // top-level paragraph only at a bullet or an ordered list starting 1.
      if (lm && (listInterrupts(lm) || (!top && lm.content.trim() !== ''))) break;
      if (ind <= 3) {
        const ht = htmlBlockType(line);
        if (ht >= 1 && ht <= 6) break;
      }
      if (ind <= 3 && line.includes('|') && j + 1 < end && matchTableDelim(lines[j + 1])) break;
    }
    paraLines.push(line);
    j++;
  }
  const text = paraLines.join('\n');
  const token = top ? { t: 'paragraph', text } : { t: 'text', text };
  return { token, next: j };
}

// --- lists ---

// Collect one list item's content lines starting at lines[i] (a marker line).
// `lm` is the marker info for the first line. Returns {content, next, hasBlank}
// where content is the item's lines (indent stripped, joined later) and
// hasBlank is true when a blank line inside the item is followed by more
// content of the same item.
function collectListItem(lines, i, end, lm) {
  const content = [];
  const contentIndent = lm.contentIndent;
  content.push(lm.content);
  let j = i + 1;
  let inPara = lm.content.trim() !== '';
  let blankRun = 0;
  let hasBlank = false;
  // An item whose first line is empty and whose next line is blank is
  // closed: nothing after the blank line belongs to it. Skip the blank
  // lines so the list can continue with a following item.
  if (lm.empty && j < end && isBlank(lines[j])) {
    let k = j, blanks = 0;
    while (k < end && isBlank(lines[k])) { blanks++; k++; }
    return { content, next: k, hasBlank: false, trailingBlanks: blanks };
  }
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      blankRun++;
      inPara = false; // a blank line ends the paragraph: no lazy continuation after it
      j++;
      continue;
    }
    const ind = lineIndent(line);
    // a list marker at an indent below the content indent ends this item
    const lm2 = matchListMarker(line);
    if (lm2 && ind < contentIndent) break;
    if (ind >= contentIndent) {
      if (blankRun > 0) hasBlank = true;
      for (let b = 0; b < blankRun; b++) content.push('');
      blankRun = 0;
      // expand leading tabs from column 0, then strip the content indent
      // (marked: Z = line with leading tabs expanded, then Z.slice(R))
      const expanded = expandLeadingTabs(line, 0);
      const c = expanded.slice(contentIndent);
      content.push(c);
      inPara = contentIsParaLine(c);
      j++;
      continue;
    }
    // indent < contentIndent and not a list marker: lazy continuation?
    // Only a paragraph line can continue lazily; a block start (hr, heading,
    // fence, setext underline, blockquote, ...) ends the item. A line
    // indented 4+ is indented code merging into the paragraph, so it also
    // continues — unless it starts a blockquote or another block.
    if (inPara && (contentIsParaLine(line) || (lineIndent(line) >= 4 && !line.trimStart().startsWith('>')))) {
      if (blankRun > 0) hasBlank = true;
      for (let b = 0; b < blankRun; b++) content.push('');
      blankRun = 0;
      // A lazy line is a paragraph continuation, not a new block: join it
      // onto the last content line so it is never re-lexed as a list.
      // An indented lazy line is indented code merging into the paragraph,
      // so strip 4 columns (cm-238 analogue for lists).
      const text = lineIndent(line) >= 4 ? stripIndent(line, 4) : line;
      if (content.length) content[content.length - 1] += '\n' + text;
      else content.push(text);
      inPara = contentIsParaLine(line) || lineIndent(line) >= 4;
      j++;
      continue;
    }
    break;
  }
  // trailing blank lines are not part of the item
  while (content.length && isBlank(content[content.length - 1])) content.pop();
  // marked trimEnd()s the item's text: trailing whitespace on the last
  // content line is dropped
  if (content.length) {
    const last = content[content.length - 1];
    const trimmed = last.replace(/[ \t]+$/, '');
    if (trimmed !== last) content[content.length - 1] = trimmed;
  }
  return { content, next: j, hasBlank, trailingBlanks: blankRun };
}

// Parse a list starting at lines[i]. Returns {tokens: listToken, next}.
function parseList(lines, i, end, links, top) {
  const first = matchListMarker(lines[i]);
  const ordered = first.ordered;
  const start = ordered ? first.start : 0;
  // the bullet char (for bullet lists) or delimiter (for ordered) must be consistent
  const firstRest = stripIndent(lines[i], lineIndent(lines[i]));
  const bulletChar = ordered ? null : firstRest.charCodeAt(0);
  const orderedDelim = ordered ? firstRest.replace(/^\d+/, '')[0] : null;
  const items = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    // an hr line ends the list (it takes precedence over a list item)
    if (matchHr(line)) break;
    const lm = matchListMarker(line);
    if (!lm || lm.ordered !== ordered) break;
    const rest = stripIndent(line, lineIndent(line));
    if (!ordered && rest.charCodeAt(0) !== bulletChar) break;
    if (ordered) {
      const d = rest.replace(/^\d+/, '')[0];
      if (d !== orderedDelim) break;
    }
    const { content, next, trailingBlanks } = collectListItem(lines, j, end, lm);
    items.push({ content, trailingBlanks });
    j = next;
    // blank lines were consumed by collectListItem's lookahead; if the next
    // line is not a same-list item, the list ends here
    if (trailingBlanks > 0 && j < end) {
      const lm3 = matchListMarker(lines[j]);
      const sameList = lm3 && lm3.ordered === ordered &&
        (!ordered ? stripIndent(lines[j], lineIndent(lines[j])).charCodeAt(0) === bulletChar
                  : stripIndent(lines[j], lineIndent(lines[j])).replace(/^\d+/, '')[0] === orderedDelim);
      if (!sameList) break;
    }
  }
  // Build item tokens (top=false so paragraphs become text tokens)
  const itemTokens = [];
  for (const item of items) {
    const content = item.content;
    while (content.length && isBlank(content[content.length - 1])) content.pop();
    const tokens = lexBlocks(content, 0, content.length, links, false, true);
    itemTokens.push(tokens);
  }
  // Loose iff any item has a blank-line separation between two of its own
  // top-level blocks, or a blank line separates two items.
  let loose = false;
  for (let idx = 0; idx < items.length; idx++) {
    if (itemTokens[idx].loose) { loose = true; break; }
    if (idx < items.length - 1 && items[idx].trailingBlanks > 0) { loose = true; break; }
  }
  // Task lists: an item whose first block is a text token starting with
  // [ ] or [x] gets a checkbox. The checkbox is extracted from the text now;
  // its placement (inside the <p> when loose, before the text when tight)
  // is decided after looseness is known.
  const itemObjs = [];
  for (let idx = 0; idx < itemTokens.length; idx++) {
    const tokens = itemTokens[idx];
    let checked = null;
    const firstTok = tokens[0];
    if (firstTok && firstTok.t === 'text') {
      const m = /^\[( |x|X)\] /.exec(firstTok.text);
      if (m) {
        checked = m[1] !== ' ';
        firstTok.text = firstTok.text.slice(m[0].length);
      }
    }
    itemObjs.push({ tokens, checked });
  }
  if (loose) {
    // loose: every text token in every item becomes a paragraph
    for (const item of itemObjs) {
      for (const tok of item.tokens) {
        if (tok.t === 'text') tok.t = 'paragraph';
      }
      // the checkbox goes inside the first paragraph
      if (item.checked !== null && item.tokens[0] && item.tokens[0].t === 'paragraph') {
        item.tokens[0].checkbox = item.checked;
      }
    }
  } else {
    // tight: the checkbox is a token before the item's text
    for (const item of itemObjs) {
      if (item.checked !== null) {
        item.tokens.unshift({ t: 'checkbox', checked: item.checked });
      }
    }
  }
  return { tokens: { t: 'list', ordered, start, items: itemObjs, loose }, next: j, trailingBlanks: items.length ? items[items.length - 1].trailingBlanks : 0 };
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

// Unescape backslash-escaped punctuation in a code fence info string.
function unescapeLang(s) {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

function renderBlocks(tokens, links) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'code': {
        const langWord = tok.lang ? unescapeLang(tok.lang).match(/\S+/)?.[0] : '';
        let r = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        const esc = escAll(r);
        out += langWord
          ? '<pre><code class="language-' + escText(langWord) + '">' + esc + '</code></pre>\n'
          : '<pre><code>' + esc + '</code></pre>\n';
        break;
      }
      case 'heading':
        out += '<h' + tok.depth + '>' + inlineToHtml(tok.text, links) + '</h' + tok.depth + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(tok.tokens, links) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const startAttr = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        let inner = '';
        for (const item of tok.items) {
          inner += '<li>' + renderBlocks(item.tokens, links) + '</li>\n';
        }
        out += '<' + tag + startAttr + '>\n' + inner + '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += tok.text;
        break;
      case 'table': {
        let thead = '<tr>\n';
        for (const cell of tok.header) {
          thead += cell.align ? '<th align="' + cell.align + '">' + inlineToHtml(cell.text, links) + '</th>\n' : '<th>' + inlineToHtml(cell.text, links) + '</th>\n';
        }
        thead += '</tr>\n';
        let tbody = '';
        for (const row of tok.rows) {
          let r = '<tr>\n';
          for (let ci = 0; ci < row.length; ci++) {
            const align = tok.header[ci] ? tok.header[ci].align : null;
            r += align ? '<td align="' + align + '">' + inlineToHtml(row[ci].text, links) + '</td>\n' : '<td>' + inlineToHtml(row[ci].text, links) + '</td>\n';
          }
          r += '</tr>\n';
          tbody += r;
        }
        out += '<table>\n<thead>\n' + thead + '</thead>\n' + (tbody ? '<tbody>' + tbody + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'paragraph': {
        const cb = tok.checkbox !== undefined && tok.checkbox !== null
          ? '<input ' + (tok.checkbox ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
          : '';
        out += '<p>' + cb + inlineToHtml(tok.text, links) + '</p>\n';
        break;
      }
      case 'text':
        out += inlineToHtml(tok.text, links);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const links = Object.create(null);
  docInLink = false;
  const lines = src.split('\n');
  const tokens = lexBlocks(lines, 0, lines.length, links, true);
  return renderBlocks(tokens, links);
}
