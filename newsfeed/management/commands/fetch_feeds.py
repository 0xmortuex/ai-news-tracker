from django.core.management.base import BaseCommand
from newsfeed.fetcher import fetch_all_sources


class Command(BaseCommand):
    help = 'Fetch all active RSS sources and store new articles'

    def handle(self, *args, **options):
        self.stdout.write('Fetching feeds...')
        summary = fetch_all_sources()
        self.stdout.write(self.style.SUCCESS(
            f"Sources checked: {summary['sources_checked']}"
        ))
        self.stdout.write(self.style.SUCCESS(
            f"New articles: {summary['total_new']}"
        ))
        if summary['errors']:
            self.stdout.write(self.style.WARNING(
                f"Errors ({len(summary['errors'])}):"
            ))
            for err in summary['errors']:
                self.stdout.write(self.style.WARNING(f'  - {err}'))
        else:
            self.stdout.write(self.style.SUCCESS('No errors.'))
