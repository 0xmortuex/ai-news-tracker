# Legacy Django app

This is the original Django implementation (DigitalOcean App Platform). It is
**not** what powers the live site and is kept only for reference.

- The live site is the static page in `../docs/` (GitHub Pages) reading
  `news.json` produced by `../scripts/ingest.mjs`.
- Nothing in the current pipeline, tests or workflows depends on this folder.
- Its source list (`newsfeed/feeds.py`) contains feeds that are dead today
  (Anthropic, Meta AI, Microsoft AI, China Daily, Caixin). Do not reuse it;
  the maintained list is `../config/sources.json`.

To run it anyway, from this folder: `pip install -r requirements.txt`,
`python manage.py migrate && python manage.py seed_sources && python manage.py fetch_feeds`.
