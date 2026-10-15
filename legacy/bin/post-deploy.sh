#!/usr/bin/env bash
set -e
python manage.py migrate --noinput
python manage.py seed_sources
python manage.py fetch_feeds || true
