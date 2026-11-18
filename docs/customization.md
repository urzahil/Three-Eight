# Customization and appearance

Three-Eight includes several dark interface styles. Each participant chooses their style locally; the preference is saved in their browser and also applies to the admin page and supported picture-in-picture windows.


## Interface styles

Available styles include:
- **Three-Eight** — the default appearance.
- **CossUI**, **AlignUI**, **DaisyUI**, **HeroUI** and **AntUI** — CSS-only looks inspired by those UI libraries.

Styles are implemented in `public/assets/css/themes.css` using CSS variables and a few component rules. The app does not load those libraries or their web fonts. Theme metadata, including `theme-color`, is defined in `public/assets/js/theme.js`; early theme initialization is handled by `public/assets/js/theme-boot.js`.

To add a theme, define the CSS overrides in `themes.css` and add an entry to the `THEMES` collection in `theme.js`.

## Changing colors

The main variables are defined in the `:root` block near the top of `public/assets/css/style.css`. For example:

```css
--accent: #f2a541;
--accent-ink: #1b1305;
```
`--accent` is the highlight color used by buttons, the logo, seek bar, links and focus rings. `--accent-ink` is the foreground text color placed over the accent. If the accent is dark, use a light `--accent-ink` to maintain contrast.

Other variable groups cover backgrounds (`--bg`, `--bg-2`, `--bg-3`), borders, text, danger/warning/success colors, subtitles, avatars, radii, overlays, video backgrounds and controls.

The icon in `public/assets/icon.svg` has accent colors hard-coded, so update its fills when changing the accent. The `theme-color` meta tag in `public/index.html` should also match the background color used by mobile browser chrome.

After editing CSS or other app assets in a Docker deployment, rebuild the image:

```bash
docker compose up -d --build
```

## Progressive Web App

Three-Eight can be installed as a PWA:
- Desktop Chrome/Edge: use the install icon in the address bar.
- Android Chrome: choose **Install app** from the browser menu.
- iPhone/iPad: Share → **Add to Home Screen**.

Installation requires HTTPS (or localhost). The service worker caches the app's own static files and prefers the server, using the cache when offline. Room connections, APIs and movie streams are not served from the service-worker cache; offline mode therefore opens the app shell but cannot join rooms.
