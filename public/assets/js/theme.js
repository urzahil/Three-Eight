// Interface styles: the default Three-Eight look, plus dark re-skins inspired by UI libraries (css/themes.css).
// The choice is per device (localStorage "te.ui"); theme-boot.js applies it before the first paint.

const KEY = 'te.ui';

/** id → label and the browser chrome color (the theme-color meta tag); keep in step with themes.css. */
export const THEMES = [
  { id: 'default', label: 'Three-Eight (default)', color: '#0f1115' },
  { id: 'coss', label: 'coss ui', color: '#0a0a0a' },
  { id: 'align', label: 'AlignUI', color: '#0e121b' },
  { id: 'daisy', label: 'daisyUI', color: '#15191e' },
  { id: 'hero', label: 'HeroUI', color: '#000000' },
  { id: 'ant', label: 'Ant Design', color: '#000000' },
];

const byId = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

export function currentTheme() {
  try {
    return byId(JSON.parse(localStorage.getItem(KEY) || 'null')).id;
  } catch {
    return 'default';
  }
}

/** Apply a style to this document (and to `extraDocs`, e.g. a Picture-in-Picture window). */
export function applyTheme(id, extraDocs = []) {
  const theme = byId(id);
  for (const doc of [document, ...extraDocs]) {
    if (!doc) continue;
    if (theme.id === 'default') delete doc.documentElement.dataset.ui;
    else doc.documentElement.dataset.ui = theme.id;
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.color);
  return theme.id;
}

export function setTheme(id, extraDocs) {
  const applied = applyTheme(id, extraDocs);
  try {
    if (applied === 'default') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(applied));
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  return applied;
}

/** Fill a <select> with the styles and keep it in sync with the saved choice. */
export function bindThemeSelect(select, getExtraDocs = () => []) {
  if (!select) return;
  select.replaceChildren(...THEMES.map((t) => new Option(t.label, t.id)));
  select.value = currentTheme();
  select.addEventListener('change', () => {
    select.value = setTheme(select.value, getExtraDocs());
    for (const other of document.querySelectorAll('select[data-theme-select]')) if (other !== select) other.value = select.value;
  });
}

applyTheme(currentTheme());
