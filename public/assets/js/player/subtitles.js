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
