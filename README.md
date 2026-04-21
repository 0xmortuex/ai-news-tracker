# AI News Tracker

A Django web app that aggregates AI news from 20 sources across the US, China, and global research labs. Built to monitor the latest developments in real-time.

## Features

- Tracks 20 RSS feeds (OpenAI, Anthropic, DeepMind, Meta AI, NVIDIA, HuggingFace, BAIR, TechCrunch, The Verge, MIT Tech Review, Ars Technica, VentureBeat, SCMP, TechNode, China Daily, Caixin, arXiv cs.AI, arXiv cs.LG)
- Filter by country (US / China / Global), source type (Company / News / Research), or specific source
- Search article titles and summaries
- Mark articles as read (one-click, opens in a new tab)
- "NEW" badge on articles less than 1 hour old
- Background refresh button (AJAX, no page reload)
- Dark-themed Tailwind UI with sticky header and hover animations

## Tech Stack

- Django 6.0.4
- Python 3.13
- SQLite (local development) / PostgreSQL (production)
- TailwindCSS via CDN
- feedparser for RSS parsing
- WhiteNoise for static file serving
- Gunicorn for WSGI in production
- Deployed on DigitalOcean App Platform

## Setup

1. Clone the repo
   ```bash
   git clone https://github.com/0xmortuex/ai-news-tracker.git
   cd ai-news-tracker
   ```
2. Create a virtualenv
   ```bash
   python -m venv .venv
   ```
3. Activate it
   - Windows (PowerShell): `.\.venv\Scripts\Activate.ps1`
   - Linux / macOS: `source .venv/bin/activate`
4. Install dependencies
   ```bash
   pip install -r requirements.txt
   ```
5. Apply migrations
   ```bash
   python manage.py migrate
   ```
6. Seed the RSS source list
   ```bash
   python manage.py seed_sources
   ```
7. Fetch articles
   ```bash
   python manage.py fetch_feeds
   ```
8. Run the dev server
   ```bash
   python manage.py runserver
   ```
9. Open http://127.0.0.1:8000/

## Project Structure

```
ai-news-tracker/
├── bin/
│   └── post-deploy.sh          # Runs on every DO deploy: migrate + seed + fetch
├── docs/
│   └── index.html              # GitHub Pages landing page
├── mysite/                     # Django project config
│   ├── settings.py             # Env-driven settings (SECRET_KEY, DATABASE_URL, etc.)
│   ├── urls.py
│   └── wsgi.py
├── newsfeed/                   # Main app
│   ├── management/commands/
│   │   ├── fetch_feeds.py      # python manage.py fetch_feeds
│   │   └── seed_sources.py     # python manage.py seed_sources
│   ├── templates/newsfeed/
│   │   └── feed.html           # Dark Tailwind UI
│   ├── admin.py
│   ├── feeds.py                # SOURCES list (20 RSS feeds)
│   ├── fetcher.py              # feedparser integration
│   ├── models.py               # Source, Article
│   ├── urls.py
│   └── views.py                # feed, mark_read, mark_all_read, fetch_now
├── Procfile                    # gunicorn mysite.wsgi --log-file -
├── requirements.txt
├── runtime.txt                 # python-3.13.12
└── manage.py
```

## Sources

### United States
- 🇺🇸 OpenAI News — Company
- 🇺🇸 Anthropic News — Company
- 🇺🇸 Google DeepMind — Company
- 🇺🇸 Google Research — Company
- 🇺🇸 Meta AI — Company
- 🇺🇸 Microsoft AI Blog — Company
- 🇺🇸 NVIDIA Blog — Company
- 🇺🇸 Hugging Face Blog — Company
- 🇺🇸 BAIR Berkeley AI — Research
- 🇺🇸 TechCrunch AI — News
- 🇺🇸 The Verge AI — News
- 🇺🇸 MIT Tech Review AI — News
- 🇺🇸 Ars Technica AI — News
- 🇺🇸 VentureBeat AI — News

### China
- 🇨🇳 South China Morning Post Tech — News
- 🇨🇳 TechNode — News
- 🇨🇳 China Daily Tech — News
- 🇨🇳 Caixin Global Tech — News

### Global Research
- 🌐 arXiv cs.AI — Research
- 🌐 arXiv cs.LG — Research

## License

MIT

---

<sub>Built by Fadi (<a href="https://github.com/0xmortuex">@0xmortuex</a>)</sub>
