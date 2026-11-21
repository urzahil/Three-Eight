// Subtitle parsing (SRT, WebVTT, ASS/SSA, MP4 timed text) and rendering.
// Cue text is normalized to a tiny safe markup: <i>, <b>, <u> and "\n".
// Rendering never uses innerHTML, so subtitle files shared by peers cannot
// inject markup into the page.

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lrm;': '‎', '&rlm;': '‏' };

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|nbsp|quot|#39|lrm|rlm);/g, (m) => ENTITIES[m] || m);
}

/** Keep only <i>, <b>, <u>; drop every other tag. Escape-free plain output. */
function cleanHtmlish(s) {
  return s
    .replace(/\r/g, '')
    .replace(/<\s*(\/?)\s*([ibu])(?:\s[^>]*)?>/gi, (m, slash, tag) => `\u0001${slash}${tag.toLowerCase()}\u0002`)
    .replace(/<[^>]*>/g, '')
    .replace(/\u0001/g, '<')
    .replace(/\u0002/g, '>');
}

function normalizeSrt(text) {
  return decodeEntities(cleanHtmlish(text)).replace(/\{\\an?\d+\}/g, '').trim();
}

function normalizeAss(text) {
  let top = false;
  let out = '';
  let i = 0;
  if (/\{[^}]*\\p[1-9]/.test(text)) return { text: '', top }; // vector drawing, not text
  while (i < text.length) {
    if (text[i] === '{') {
      const end = text.indexOf('}', i);
      if (end < 0) break;
      const tags = text.slice(i + 1, end);
      const re = /\\(an?)(\d+)|\\([ibu])([01])/g;
      let m;
      while ((m = re.exec(tags))) {
        if (m[1] === 'an' && ['7', '8', '9'].includes(m[2])) top = true;
        if (m[1] === 'a' && ['5', '6', '7'].includes(m[2])) top = true;
        if (m[3]) out += m[4] === '1' ? `<${m[3]}>` : `</${m[3]}>`;
      }
      i = end + 1;
      continue;
    }
    out += text[i++];
  }
  out = out.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  return { text: out.trim(), top };
}

function parseTime(s) {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?\s*$/.exec(s);
  if (!m) return NaN;
  const frac = m[4] ? parseInt(m[4], 10) / Math.pow(10, m[4].length) : 0;
  return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + frac;
}

export function parseSrt(data) {
  const cues = [];
  const blocks = data.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const text = normalizeSrt(lines.slice(ti + 1).join('\n'));
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

export function parseVtt(data) {
  const cues = [];
  const blocks = data.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, rest] = lines[ti].split('-->');
    const parts = rest.trim().split(/\s+/);
    const start = parseTime(a);
    const end = parseTime(parts[0]);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const settings = parts.slice(1).join(' ');
    const lineSetting = /line:(\d+)%?/.exec(settings);
    const top = lineSetting ? parseInt(lineSetting[1], 10) < 50 : false;
    const text = normalizeSrt(lines.slice(ti + 1).join('\n'));
    if (text) cues.push({ start, end, text, top });
  }
  return cues;
}

export function parseAss(data) {
  const cues = [];
  let format = null;
  let inEvents = false;
  for (const rawLine of data.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format:/i.test(line)) {
      format = line.slice(7).split(',').map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue:/i.test(line)) continue;
    const f = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const body = line.slice(9).trim();
    const fields = [];
    let rest = body;
    for (let i = 0; i < f.length - 1; i++) {
      const c = rest.indexOf(',');
      if (c < 0) break;
      fields.push(rest.slice(0, c));
      rest = rest.slice(c + 1);
    }
    fields.push(rest);
    const get = (k) => fields[f.indexOf(k)];
    const start = parseTime(get('start') || '');
    const end = parseTime(get('end') || '');
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const n = normalizeAss(get('text') || '');
    if (n.text) cues.push({ start, end, text: n.text, top: n.top });
  }
  return cues;
}

/** Parse a subtitle file by extension / content sniffing. */
export function parseSubtitleFile(name, data) {
  const lower = name.toLowerCase();
  let cues;
  if (lower.endsWith('.vtt') || /^﻿?WEBVTT/.test(data)) cues = parseVtt(data);
  else if (lower.endsWith('.ass') || lower.endsWith('.ssa') || /^﻿?\[Script Info\]/i.test(data)) cues = parseAss(data);
  else cues = parseSrt(data);
  return sortCues(cues);
}

// How long an embedded subtitle without a BlockDuration is shown (mkv.js), unless the next one starts first.
const DEFAULT_CUE_SECONDS = 4;

/** Trim embedded cues whose end was guessed so they don't overlap the next one. `s` is a subtitle with `cues`. */
export function closeGaps(s) {
  for (let i = 0; i < s.cues.length - 1; i++) {
    const c = s.cues[i];
    // `end` was guessed (no BlockDuration): computed as start + 4, which floating point does not always undo exactly.
    const guessed = Math.abs(c.end - c.start - DEFAULT_CUE_SECONDS) < 1e-6;
    if (c.end > s.cues[i + 1].start && guessed) c.end = s.cues[i + 1].start;
  }
}

/** Normalize one cue extracted from a container. */
export function normalizeEmbeddedCue(format, cue) {
  const raw = cue.raw;
  if (format === 'ass-block') {
    // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    let rest = raw;
    for (let i = 0; i < 8; i++) {
      const c = rest.indexOf(',');
      if (c < 0) break;
      rest = rest.slice(c + 1);
    }
    const n = normalizeAss(rest);
    return n.text ? { start: cue.start, end: cue.end, text: n.text, top: n.top } : null;
  }
  const text = normalizeSrt(raw);
  return text ? { start: cue.start, end: cue.end, text } : null;
}

export function sortCues(cues) {
  return cues.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
}

/** Active cues at time t. cues must be sorted by start. */
export function activeCues(cues, t) {
  let lo = 0, hi = cues.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const out = [];
  for (let i = idx; i >= 0 && i > idx - 64; i--) if (cues[i].end > t) out.push(cues[i]);
  return out.reverse();
}

/** Build DOM nodes for the mini markup without innerHTML. */
function renderMarkup(text, parent) {
  const stack = [parent];
  const re = /<(\/?)([ibu])>/g;
  let last = 0;
  let m;
  const addText = (s) => {
    const lines = s.split('\n');
    lines.forEach((ln, i) => {
      if (i > 0) stack[stack.length - 1].appendChild(document.createElement('br'));
      if (ln) stack[stack.length - 1].appendChild(document.createTextNode(ln));
    });
  };
  while ((m = re.exec(text))) {
    addText(text.slice(last, m.index));
    last = re.lastIndex;
    if (!m[1]) {
      const el = document.createElement(m[2]);
      stack[stack.length - 1].appendChild(el);
      stack.push(el);
    } else if (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() === m[2]) {
      stack.pop();
    }
  }
  addText(text.slice(last));
}

export class SubtitleRenderer {
  constructor(container, video) {
    this.container = container;
    this.video = video;
    this.cues = [];
    this.delay = 0;
    this.key = '';
    this.bottom = document.createElement('div');
    this.bottom.className = 'subs subs-bottom';
    this.top = document.createElement('div');
    this.top.className = 'subs subs-top';
    container.append(this.top, this.bottom);
    this._resize = () => this.layout();
    new ResizeObserver(this._resize).observe(container);
    video.addEventListener('loadedmetadata', this._resize);
  }

  setCues(cues) {
    this.cues = cues || [];
    this.key = null;
  }

  layout() {
    // Position the text over the visible video picture (not the letterbox).
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9;
    const scale = Math.min(cw / vw, ch / vh);
    const w = vw * scale, h = vh * scale;
    const left = (cw - w) / 2, top = (ch - h) / 2;
    const fs = Math.max(14, Math.round(h * 0.052));
    for (const el of [this.bottom, this.top]) {
      el.style.left = `${left}px`;
      el.style.width = `${w}px`;
      el.style.fontSize = `${fs}px`;
    }
    this.bottom.style.bottom = `${ch - top - h + h * 0.06}px`;
    this.top.style.top = `${top + h * 0.05}px`;
  }

  update(time) {
    const act = this.cues.length ? activeCues(this.cues, time - this.delay) : [];
    const key = act.map((c) => c.start + ':' + c.text).join('|');
    if (key === this.key) return;
    this.key = key;
    this.bottom.replaceChildren();
    this.top.replaceChildren();
    for (const c of act) {
      const line = document.createElement('div');
      const span = document.createElement('span');
      line.appendChild(span);
      renderMarkup(c.text, span);
      (c.top ? this.top : this.bottom).appendChild(line);
    }
  }
}

/** Our mini markup is valid WebVTT cue text once stray & < > are escaped. */
export function cueToVtt(text) {
  const esc = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  return text.replace(/<\/?[ibu]>|[&<>]/g, (m) => esc[m] || m);
}

/**
 * Mirrors the selected subtitle into ONE native text track on the <video>, so
 * system picture-in-picture windows (which can't show our DOM overlay) can
 * still render captions. The track is created lazily.
 */
export class NativeCaptions {
  constructor(video) {
    this.video = video;
    this.track = null;
    this.baseMode = 'hidden'; // 'hidden' | 'showing'
    this.cues = [];
    this.offset = 0;
    this._timer = 0;
    // iPhone full screen is the system's own video player: our overlay is not drawn there, the track has to show.
    this.systemFullscreen = false;
    const update = () => this._applyMode();
    video.addEventListener('enterpictureinpicture', update);
    video.addEventListener('leavepictureinpicture', update);
    video.addEventListener('webkitbeginfullscreen', () => {
      this.systemFullscreen = true;
      update();
    });
    video.addEventListener('webkitendfullscreen', () => {
      this.systemFullscreen = false;
      update();
    });
  }

  /** 'hidden' keeps the track silent in the page; 'showing' always renders it. */
  setMode(mode) {
    this.baseMode = mode === 'showing' ? 'showing' : 'hidden';
    this._applyMode();
  }

  _applyMode() {
    if (!this.track) return;
    const inPip = document.pictureInPictureElement === this.video;
    this.track.mode = inPip || this.systemFullscreen || this.baseMode === 'showing' ? 'showing' : 'hidden';
  }

  /** cues: our cue objects; offset: seconds added to each time (subtitle delay + media shift). */
  set(cues, offset, immediate = false) {
    this.cues = cues;
    this.offset = offset;
    clearTimeout(this._timer);
    if (immediate) this._rebuild();
    else this._timer = setTimeout(() => this._rebuild(), 300);
  }

  clear() {
    this.set([], 0, true);
  }

  _rebuild() {
    if (!this.track) {
      if (!this.cues.length || typeof this.video.addTextTrack !== 'function' || typeof VTTCue === 'undefined') return;
      this.track = this.video.addTextTrack('subtitles', 'Subtitles', 'und');
      this._applyMode();
    }
    for (const c of [...(this.track.cues || [])]) this.track.removeCue(c);
    for (const c of this.cues) {
      const start = Math.max(0, c.start + this.offset);
      const end = c.end + this.offset;
      if (end <= start) continue;
      const cue = new VTTCue(start, end, cueToVtt(c.text));
      if (c.top) cue.line = 0;
      this.track.addCue(cue);
    }
  }
}

// ---- decoding subtitle files -----------------------------------------------------------------------------------
// A subtitle file is plain text in whatever encoding its author's tools used: UTF-8 today, UTF-16 from some Windows
// tools, and an older one-byte (or East Asian) code page for many files from the 2000s. The bytes alone do not say
// which, so: a byte-order mark decides; then valid UTF-8; then a code page, chosen by a small plausibility score
// (the right one gives words of one script, in sensible case, without stray symbols), or as the user set it.

/** The code pages a user can pick for subtitle files that are not Unicode (Settings). */
export const SUBTITLE_ENCODINGS = [
  ['auto', 'Automatic'],
  ['windows-1252', 'Western (Windows-1252)'],
  ['windows-1250', 'Central European (Windows-1250)'],
  ['windows-1251', 'Cyrillic (Windows-1251)'],
  ['windows-1253', 'Greek (Windows-1253)'],
  ['windows-1254', 'Turkish (Windows-1254)'],
  ['windows-1255', 'Hebrew (Windows-1255)'],
  ['windows-1256', 'Arabic (Windows-1256)'],
  ['windows-1257', 'Baltic (Windows-1257)'],
  ['windows-1258', 'Vietnamese (Windows-1258)'],
  ['windows-874', 'Thai (Windows-874)'],
  ['gb18030', 'Chinese, simplified (GB18030)'],
  ['big5', 'Chinese, traditional (Big5)'],
  ['shift_jis', 'Japanese (Shift_JIS)'],
  ['euc-kr', 'Korean (EUC-KR)'],
];

/** The code page older subtitle files in this language usually use (what browsers assume for that locale). */
function legacyFor(lang) {
  const [l, region = ''] = String(lang || '').toLowerCase().split(/[-_]/);
  if (['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk', 'ky', 'tg', 'mn'].includes(l)) return 'windows-1251';
  if (['pl', 'cs', 'sk', 'hu', 'hr', 'sl', 'ro', 'bs', 'sq'].includes(l)) return 'windows-1250';
  if (l === 'el') return 'windows-1253';
  if (l === 'tr' || l === 'az') return 'windows-1254';
  if (l === 'he' || l === 'iw' || l === 'yi') return 'windows-1255';
  if (['ar', 'fa', 'ur'].includes(l)) return 'windows-1256';
  if (['lt', 'lv', 'et'].includes(l)) return 'windows-1257';
  if (l === 'vi') return 'windows-1258';
  if (l === 'th') return 'windows-874';
  if (l === 'ja') return 'shift_jis';
  if (l === 'ko') return 'euc-kr';
  if (l === 'zh') return ['tw', 'hk', 'mo', 'hant'].includes(region) ? 'big5' : 'gb18030';
  return 'windows-1252';
}

const SCRIPTS = [['Latin', /\p{Script=Latin}/u], ['Cyrillic', /\p{Script=Cyrillic}/u], ['Greek', /\p{Script=Greek}/u],
  ['Hebrew', /\p{Script=Hebrew}/u], ['Arabic', /\p{Script=Arabic}/u], ['Thai', /\p{Script=Thai}/u],
  ['CJK', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u]];
const scriptOf = (ch) => SCRIPTS.find(([, re]) => re.test(ch))?.[0] || 'Other';
// Letters only Icelandic and Faroese use: in other text they are Turkish ğ ş (or Baltic š ž) read as Western.
const ICELANDIC = /[ðþÐÞ]/g;
// A symbol wedged between two letters ("Za¿ó³æ" is Polish read as Western). Punctuation that sits inside words
// (apostrophes, hyphens, dots of abbreviations...) does not count; ¡ ¿ superscripts and the like do.
const WEDGED = /\p{L}[^\p{L}\p{M}\s0-9'’`´\-–—.,:;!?"“”„«»‹›()[\]{}/\\*&#@%+=<>_~|…]\p{L}/gu;
const CYRILLIC_VOWELS = /[аеёиоуыэюяіїєѣАЕЁИОУЫЭЮЯІЇЄ]/;
const GREEK_VOWELS = /[αεηιουωάέήίόύώϊϋΐΰΑΕΗΙΟΥΩΆΈΉΊΌΎΏΪΫ]/;

/**
 * How plausible `text` is as real writing (higher is better). Only what differs between code pages counts: ASCII
 * reads the same in all of them. Each word with letters beyond ASCII scores +1, or a penalty when it looks like text
 * of another script read with the wrong code page.
 */
export function textScore(text, lang = '') {
  let score = 0;
  score -= 10 * (text.match(/[�\u0080-\u009F]/g) || []).length; // bytes the code page does not define
  score -= 3 * (text.match(WEDGED) || []).length;
  if (!/^(is|fo)\b/i.test(lang)) score -= 2 * (text.match(ICELANDIC) || []).length;
  for (const word of text.match(/\p{L}[\p{L}\p{M}]*/gu) || []) {
    if (/^[\x00-\x7f]*$/.test(word)) continue;
    const letters = [...word].filter((c) => /\p{L}/u.test(c));
    const scripts = new Set(letters.map(scriptOf));
    if (scripts.size > 1) score -= 5; // "cosм": Latin and Cyrillic in one word
    else if (/\p{Ll}\p{Lu}/u.test(word)) score -= 3; // "КблзмЭсб", "гСНИЗЎ": Greek or Arabic read as Cyrillic
    // "Ïðèâåò": a Latin word made (almost) only of accented letters is another script read as Western.
    else if (scripts.has('Latin') && letters.length >= 3 && letters.filter((c) => c > '\x7f').length >= 0.8 * letters.length) score -= 3;
    // Hebrew read as Cyrillic: words without a vowel ("щм"), or ending in a hard sign ("мшаеъ"), which no language
    // written in Cyrillic has.
    else if (scripts.has('Cyrillic') && ((letters.length >= 2 && !CYRILLIC_VOWELS.test(word)) || /[ъЪ]$/.test(word))) score -= 3;
    // ... or as Greek: words without a vowel ("ξδ"), or with ΐ ΰ, which Greek hardly ever uses (Hebrew's alef reads so).
    else if (scripts.has('Greek') && ((letters.length >= 2 && !GREEK_VOWELS.test(word)) || /[ΐΰ]/.test(word))) score -= 3;
    else score += 1;
  }
  return score;
}

/** UTF-16 without a byte-order mark: ASCII characters leave a zero byte in every other position. */
function sniffUtf16(bytes) {
  const n = Math.min(bytes.length & ~1, 4096);
  if (n < 8) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  const pairs = n / 2;
  if (odd > pairs * 0.3 && even < pairs * 0.05) return 'utf-16le';
  if (even > pairs * 0.3 && odd < pairs * 0.05) return 'utf-16be';
  return null;
}

function decodeAs(encoding, bytes) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return null; // this browser does not know the encoding
  }
}

/**
 * Subtitle file bytes as text: { text, encoding }. `encoding` ('auto' or one of SUBTITLE_ENCODINGS) is the code page
 * for files that are not Unicode; Unicode files (a byte-order mark, UTF-16, valid UTF-8) are always read as such.
 * `lang` (the browser's language) decides between code pages that look equally plausible.
 */
export function decodeSubtitleBytes(bytes, { encoding = 'auto', lang = '' } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(b), encoding: 'utf-8' };
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b), encoding: 'utf-16le' };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b), encoding: 'utf-16be' };
  const utf16 = sniffUtf16(b);
  if (utf16) return { text: new TextDecoder(utf16).decode(b), encoding: utf16 };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' };
  } catch { /* not UTF-8: a code page */ }
  if (encoding !== 'auto') {
    const text = decodeAs(encoding, b);
    if (text !== null) return { text, encoding };
  }
  // The language's own code page first (it wins a tie), then the ones a score tells apart. Western text reads as
  // plausibly in Turkish and Central European, so those win only on evidence (ğ ş, ż ł ą...). Baltic, Vietnamese,
  // Thai and East Asian ones are picked by the language, or in Settings.
  const own = legacyFor(lang);
  const candidates = [...new Set([own, 'windows-1252', 'windows-1254', 'windows-1250', 'windows-1251', 'windows-1253', 'windows-1255', 'windows-1256'])];
  const sample = b.subarray(0, 64 * 1024); // plenty to judge by, and a large file is not scored seven times over
  let best = null;
  for (const enc of candidates) {
    const text = decodeAs(enc, sample);
    if (text === null) continue;
    const score = textScore(text, lang);
    if (!best || score > best.score) best = { encoding: enc, score };
  }
  if (!best) return { text: new TextDecoder().decode(b), encoding: 'utf-8' };
  return { text: decodeAs(best.encoding, b), encoding: best.encoding };
}
