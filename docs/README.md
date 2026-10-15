# docs/ (GitHub Pages)

Served from `master:/docs` at https://0xmortuex.github.io/ai-news-tracker/

- `index.html`: the site. The News tab fetches
  `https://raw.githubusercontent.com/0xmortuex/ai-news-tracker/data/news.json`.
  Only when that is unreachable does it fall back (clearly marked) to the old
  in-browser scrape. The Guides tab is unchanged (`#/guides`).
- `CONTRACT.md`, `news.schema.json`: the `ai-news/1` contract.
- `guides-lib.js`, `guide-sources.json`, `featured-guides.json`, `tests/`: Guides tab.

Local preview: from the repo root run `npm run serve`, then open
`http://127.0.0.1:8080/docs/index.html?data=../data/news.json` (the `data` query
parameter accepts only same-origin relative `.json` paths).

Pages setup: Settings > Pages > Deploy from a branch > `master` / `/docs`.
