import logging
import re
from datetime import datetime, timezone
import feedparser
from django.utils import timezone as django_timezone
from .models import Article, Source

logger = logging.getLogger(__name__)


def parse_published_date(entry):
    for attr in ('published_parsed', 'updated_parsed', 'created_parsed'):
        time_struct = getattr(entry, attr, None)
        if time_struct:
            try:
                return datetime(*time_struct[:6], tzinfo=timezone.utc)
            except (ValueError, TypeError):
                continue
    return django_timezone.now()


def fetch_source(source):
    new_count = 0
    try:
        parsed = feedparser.parse(source.feed_url)
        if parsed.bozo and not parsed.entries:
            logger.warning(f'Failed to parse {source.name}: {parsed.bozo_exception}')
            return 0
        for entry in parsed.entries[:50]:
            url = entry.get('link', '').strip()
            title = entry.get('title', '').strip()
            if not url or not title:
                continue
            if Article.objects.filter(url=url).exists():
                continue
            summary = entry.get('summary', '') or entry.get('description', '')
            summary = re.sub(r'<[^>]+>', '', summary)[:1000]
            Article.objects.create(
                source=source,
                title=title[:500],
                url=url[:1000],
                summary=summary,
                published_date=parse_published_date(entry),
            )
            new_count += 1
        source.last_fetched = django_timezone.now()
        source.save(update_fields=['last_fetched'])
    except Exception as e:
        logger.error(f'Error fetching {source.name}: {e}')
    return new_count


def fetch_all_sources():
    summary = {'total_new': 0, 'sources_checked': 0, 'errors': []}
    for source in Source.objects.filter(is_active=True):
        try:
            new = fetch_source(source)
            summary['total_new'] += new
            summary['sources_checked'] += 1
        except Exception as e:
            summary['errors'].append(f'{source.name}: {e}')
    return summary
