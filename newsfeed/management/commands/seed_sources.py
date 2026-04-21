from django.core.management.base import BaseCommand
from newsfeed.feeds import SOURCES
from newsfeed.models import Source


class Command(BaseCommand):
    help = 'Seed initial RSS sources into the database'

    def handle(self, *args, **options):
        created_count = 0
        updated_count = 0
        for source_data in SOURCES:
            source, created = Source.objects.update_or_create(
                feed_url=source_data['feed_url'],
                defaults={
                    'name': source_data['name'],
                    'url': source_data['url'],
                    'country': source_data['country'],
                    'source_type': source_data['source_type'],
                    'is_active': True,
                },
            )
            if created:
                created_count += 1
                self.stdout.write(self.style.SUCCESS(f'Created: {source.name}'))
            else:
                updated_count += 1
        self.stdout.write(self.style.SUCCESS(
            f'Done. Created {created_count}, updated {updated_count}. Total: {Source.objects.count()}'
        ))
