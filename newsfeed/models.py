from django.db import models


class Source(models.Model):
    COUNTRY_CHOICES = [
        ('US', 'United States'),
        ('CN', 'China'),
        ('OTHER', 'Other'),
    ]

    SOURCE_TYPE_CHOICES = [
        ('COMPANY', 'Company Blog'),
        ('NEWS', 'News Site'),
        ('RESEARCH', 'Research'),
    ]

    name = models.CharField(max_length=200)
    url = models.URLField(unique=True)
    feed_url = models.URLField()
    country = models.CharField(max_length=10, choices=COUNTRY_CHOICES, default='OTHER')
    source_type = models.CharField(max_length=20, choices=SOURCE_TYPE_CHOICES, default='COMPANY')
    is_active = models.BooleanField(default=True)
    last_fetched = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f'{self.name} ({self.country})'


class Article(models.Model):
    source = models.ForeignKey(Source, on_delete=models.CASCADE, related_name='articles')
    title = models.CharField(max_length=500)
    url = models.URLField(unique=True, max_length=1000)
    summary = models.TextField(blank=True)
    published_date = models.DateTimeField()
    fetched_at = models.DateTimeField(auto_now_add=True)
    is_read = models.BooleanField(default=False)

    class Meta:
        ordering = ['-published_date']
        indexes = [
            models.Index(fields=['-published_date']),
            models.Index(fields=['source', '-published_date']),
        ]

    def __str__(self):
        return f'{self.title[:80]} ({self.source.name})'
