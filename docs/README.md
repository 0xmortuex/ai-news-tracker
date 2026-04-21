# GitHub Pages — Landing Page

`index.html` in this folder is served as a static landing page for the project.

## How to enable GitHub Pages

1. Go to **https://github.com/0xmortuex/ai-news-tracker/settings/pages**
2. Under **Source**, select **Deploy from a branch**
3. **Branch:** `master` — **Folder:** `/docs`
4. Click **Save**
5. Wait 1–2 minutes. The site goes live at:

   **https://0xmortuex.github.io/ai-news-tracker/**

Any push to `master` that touches `docs/` will trigger a re-publish automatically.

## Local preview

Just open `docs/index.html` in a browser — no build step, Tailwind is loaded via CDN.

## Editing

- Update copy/sources/stack inline in `index.html`.
- When you add real screenshots, replace the two placeholder boxes in the "Screenshots" section with `<img>` tags (drop the images into `docs/` and reference them relatively).
