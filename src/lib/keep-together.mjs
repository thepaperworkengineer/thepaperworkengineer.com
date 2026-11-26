// Keeps phrases that belong together on one line, at every screen size.
//
// It rewrites the spaces inside short phrases as non-breaking spaces, so a line can only
// break where a reader would pause. It never touches markup, attributes, scripts or styles:
// only the text between tags. Used by src/middleware.ts on every page, and by
// scripts/keep-together.mjs on the design files.
//
// The rules, strongest first:
//  1. The last words of a paragraph or heading stay together (no single word on the last line).
//  2. A sentence's first word stays with the next word ("Leave with", "Book a").
//  3. Labels and numbers stay with what they label: "Details: Substack’s", "ISO 13485",
//     "23 CAPAs", "Nov 13, 2026", "QA/RA ·".
//  4. Small words stay with the word after them: a, the, of, to, and, I, my, will …
//  5. A sentence's last word doesn't start a line alone ("the problem.", "audit anyway.").
//  6. Hyphenated words never split at the hyphen ("30-minute", "Paper-folded"): they get
//     a <span class="tpe-nb"> (no-break, even on the narrowest screens).
// A run of joined words is capped (about 24 characters, less in big headings) so nothing
// can get too wide for a small phone.
import { parse } from 'parse5';

const WEAK = new Set(
  (
    'a an the of in on at to for with by from into onto about as via per than under over after before without within between through across like ' +
    'and or but nor so if because that ' +
    'my your our its his her their this these those every each any all no not some one ' +
    'i i’m i’ll i’ve i’d we you he she they it’s that’s there’s what’s here’s who what when how why where which ' +
    'is are was were be been will can could would should may might must do does did has have had am get let’s'
  ).split(' '),
);
const MONTHS = new Set('jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december'.split(' '));
const SEPARATORS = new Set(['·', '|', '—', '–', '&', '/', '→']);

const BLOCK_TAGS = new Set('address article aside blockquote body button dd details div dl dt figcaption figure footer form h1 h2 h3 h4 h5 h6 header label li main nav ol p section summary table td th tr ul'.split(' '));
// Inline tags this site styles as blocks (found by checking the computed layout).
const BLOCK_CLASSES = ['tpe-skip', 'tpe-word', 'tpe-hcta', 'tpe-btn', 'tpe-link', 'tpe-stat-n', 'tpe-stat-l', 'tpe-author-name', 'tpe-tag', 'tpe-meta', 'tpe-reel-t', 'tpe-reel-d', 'tpe-svc', 'tpe-svc-d', 'tpe-more-t', 'tpe-more-s'];
// Flex containers: text inside them is one flex item, so a hyphen <span> must not split it into several.
const FLEX_CLASSES = ['tpe-btn', 'tpe-link', 'tpe-tag', 'tpe-author-name', 'tpe-hcta', 'tpe-meta'];
const SKIP_TAGS = new Set('head script style svg math template textarea pre code noscript title helmet'.split(' '));
const SKIP_CLASSES = ['tpe-sr'];
// Longest run of joined characters, by the tag or class that holds the text: big type gets
// shorter runs so a joined phrase always fits a 280px-wide phone.
const MAX_RUN = { h1: 14, h2: 13, 'tpe-h1': 14, 'tpe-h2': 13, 'tpe-stat-n': 12, 'tpe-lede': 20, h3: 18, 'tpe-btn': 14 };
const DEFAULT_MAX = 24;
const MAX_WORDS = 5;
// Small words that matter most to keep with the next word come first.
const ARTICLES = new Set(['a', 'an', 'the', 'to']);
const PRONOUNS_AUX = new Set('i we you he she they my your our its his her their this these those is are was were be been will can could would should may might must do does did has have had am every each any all no not some one'.split(' '));
const MAX_HYPHENATED = 18;

const NBSP = '\u00a0';
const classes = (el) => (el.attrs?.find((a) => a.name === 'class')?.value ?? '').split(/\s+/);
const isBlock = (el) => BLOCK_TAGS.has(el.tagName) || classes(el).some((c) => BLOCK_CLASSES.includes(c));
const isSkipped = (el) => SKIP_TAGS.has(el.tagName) || classes(el).some((c) => SKIP_CLASSES.includes(c));

const bare = (t) => t.toLowerCase().replace(/^[“"‘(\[]+/, '').replace(/[”"’)\]]+$/, '');
const trailingPunct = (t) => /[,.;:!?)\]”"’]$/.test(t.replace(/’s$|’t$|’ll$|’m$|’re$|’ve$|’d$/, ''));
const endsSentence = (t) => /[.?!…][”"’)]*$/.test(t);
const isNumberish = (t) => /^[\d(]/.test(t);

/** Collect runs of text (one per block), skipping hidden and non-text parts. */
function collect(root) {
  const seqs = [];
  let cur = null;
  const start = (keys) => { cur = { keys, segs: [] }; seqs.push(cur); };
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeName === '#text') { cur.segs.push({ node: child, text: child.value }); continue; }
      if (!child.tagName) continue;
      if (child.tagName === 'br') { cur.segs.push({ node: null, text: '\n' }); continue; }
      if (isSkipped(child)) { cur.segs.push({ node: null, text: ' ' }); continue; }
      if (isBlock(child)) {
        const resume = cur.keys;
        start([child.tagName, ...classes(child)]);
        walk(child.content ?? child);
        start(resume);
      } else {
        walk(child.content ?? child);
      }
    }
  };
  start(['body']);
  walk(root);
  return seqs.filter((s) => s.segs.some((g) => g.node && g.text.trim()));
}

/** Decide which gaps between words to join, and which words to keep from splitting at a hyphen. */
function plan(seq) {
  let S = '';
  const owner = [];
  for (const g of seq.segs) { for (let i = 0; i < g.text.length; i++) owner.push({ seg: g, i }); S += g.text; }
  const toks = [];
  const re = /[^ \t\n\r\f]+/g;
  let m;
  while ((m = re.exec(S))) toks.push({ t: m[0], s: m.index, e: m.index + m[0].length });
  if (toks.length < 2) return { S, owner, toks, glue: [], wrap: [] };

  const max = Math.min(DEFAULT_MAX, ...seq.keys.map((k) => MAX_RUN[k] ?? DEFAULT_MAX));
  const cands = [];
  const sentenceStart = (i) => i === 0 || /[.?!:][”"’)]*$/.test(toks[i - 1].t);
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i].t, u = toks[i + 1].t;
    // never join across a <br> or hidden text
    if (owner.slice(toks[i].e, toks[i + 1].s).some((o) => !o.seg.node)) continue;
    const b = bare(t);
    let p = 0;
    if (i === toks.length - 2 && !/[.?!:;]$/.test(t)) p = 6; // last words together
    // …and if those two are short ("it out."), one more word too ("sort it out.")
    if (i === toks.length - 3 && !/[.?!:;]$/.test(t) && toks[i + 1].t.length + toks[i + 2].t.length < 9) p = 6;
    if (SEPARATORS.has(u)) p = Math.max(p, 6); // "QA/RA ·": keep the separator at the line end
    if (/:$/.test(t)) p = Math.max(p, 5); // "Details: Substack’s"
    if (MONTHS.has(b.replace(/\.$/, '')) && /^\d/.test(u)) p = Math.max(p, 5); // "Nov 13,"
    if (/^\d+,$/.test(t) && /^\d{4}/.test(u)) p = Math.max(p, 5); // "13, 2026"
    if (/^\d/.test(u) && /^[A-Z][A-Za-z]{0,5}$/.test(t)) p = Math.max(p, 5); // "ISO 13485", "Part 11"
    if (t === 'Class' && /^(I|II|III)\b/.test(u)) p = Math.max(p, 5);
    if (isNumberish(t) && !trailingPunct(t) && /^[A-Za-z]/.test(u)) p = Math.max(p, 5); // "23 CAPAs", "30-minute call"
    if (!trailingPunct(t) && sentenceStart(i)) p = Math.max(p, 4); // "Leave with"
    if (!trailingPunct(t) && ARTICLES.has(b)) p = Math.max(p, 4); // "a QMS", "to FDA’s"
    const last = i + 1 === toks.length - 1;
    if (!trailingPunct(t) && endsSentence(u) && (last || sentenceStart(i + 2)) && t.length + u.length < 18) p = Math.max(p, 3.5); // "the problem."
    if (!trailingPunct(t) && WEAK.has(b)) p = Math.max(p, PRONOUNS_AUX.has(b) ? 2 : 3); // "of medical", "I write"
    if (p) cands.push({ i, p });
  }
  // Accept the strongest joins first, as long as no joined run gets too long.
  const left = toks.map((_, i) => i), right = toks.map((_, i) => i);
  const runLen = (a, b) => toks[b].e - toks[a].s;
  const glue = [];
  // strongest first; among equals, the join that makes the shorter run
  cands.sort((a, b) => b.p - a.p || runLen(left[a.i], right[a.i + 1]) - runLen(left[b.i], right[b.i + 1]) || a.i - b.i);
  for (const { i } of cands) {
    const a = left[i], b = right[i + 1];
    if (runLen(a, b) > max || b - a + 1 > MAX_WORDS) continue;
    glue.push(i);
    for (let k = a; k <= b; k++) { left[k] = a; right[k] = b; }
  }
  // Hyphenated words: wrapped so they never split at the hyphen.
  const wrap = toks.filter((x) => /^[“"‘(]?[\p{L}\p{N}’']+(-[\p{L}\p{N}’']+)+[,.;:!?”"’)]*$/u.test(x.t) && x.t.length <= MAX_HYPHENATED);
  return { S, owner, toks, glue, wrap };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Returns the html with phrases kept together. */
export function keepTogether(html) {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const htmlEl = doc.childNodes.find((n) => n.tagName === 'html');
  const body = htmlEl?.childNodes.find((n) => n.tagName === 'body');
  if (!body) return html;

  // edits per text node: index -> replacement ('' deletes, NBSP joins), plus ranges to wrap
  const edits = new Map();
  const get = (node) => { if (!edits.has(node)) edits.set(node, { chars: new Map(), wraps: [] }); return edits.get(node); };

  for (const seq of collect(body)) {
    const { owner, toks, glue, wrap } = plan(seq);
    for (const i of glue) {
      const from = toks[i].e, to = toks[i + 1].s;
      const first = owner[from];
      if (!first?.seg.node || !first.seg.text.replace(/[\s\u00a0]/g, '')) continue; // never fill a whitespace-only node
      if (from === to) continue;
      get(first.seg.node).chars.set(first.i, NBSP);
      for (let k = from + 1; k < to; k++) { const o = owner[k]; if (o.seg.node) get(o.seg.node).chars.set(o.i, ''); }
    }
    for (const x of wrap) {
      const a = owner[x.s], b = owner[x.e - 1];
      if (!a?.seg.node || a.seg !== b.seg) continue; // only when the word sits in one text node
      const core = x.t.match(/^[“"‘(]?(.*?)[,.;:!?”"’)]*$/u);
      const lead = x.t.length - x.t.replace(/^[“"‘(]+/, '').length;
      const coreLen = core[1].length;
      get(a.seg.node).wraps.push([a.i + lead, a.i + lead + coreLen]);
    }
  }

  // Splice the changed text nodes back into the original source, from the end.
  const changes = [];
  for (const [node, { chars, wraps }] of edits) {
    if (!chars.size && !wraps.length) continue;
    const loc = node.sourceCodeLocation;
    if (!loc) continue;
    const text = node.value;
    const opens = new Set(wraps.map((w) => w[0])), closes = new Set(wraps.map((w) => w[1]));
    let out = '';
    for (let k = 0; k <= text.length; k++) {
      if (closes.has(k)) out += '</span>';
      if (opens.has(k)) out += '<span class="tpe-nb">';
      if (k === text.length) break;
      const c = chars.has(k) ? chars.get(k) : text[k];
      out += esc(c);
    }
    // In a flex container, keep the text one flex item by wrapping all of it.
    if (wraps.length && node.parentNode && classes(node.parentNode).some((c) => FLEX_CLASSES.includes(c))) out = `<span>${out}</span>`;
    changes.push([loc.startOffset, loc.endOffset, out]);
  }
  changes.sort((a, b) => b[0] - a[0]);
  let result = html;
  for (const [s, e, out] of changes) result = result.slice(0, s) + out + result.slice(e);
  return result;
}

