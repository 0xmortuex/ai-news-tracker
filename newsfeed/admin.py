from django.contrib import admin
from .models import Source, Article


@admin.register(Source)
class SourceAdmin(admin.ModelAdmin):
    list_display = ('name', 'country', 'source_type', 'is_active', 'last_fetched')
    list_filter = ('country', 'source_type', 'is_active')
    search_fields = ('name', 'url', 'feed_url')
    list_editable = ('is_active',)


@admin.register(Article)
class ArticleAdmin(admin.ModelAdmin):
    list_display = ('title', 'source', 'published_date', 'is_read', 'fetched_at')
    list_filter = ('is_read', 'source__country', 'source__source_type', 'source')
    search_fields = ('title', 'summary', 'url')
    date_hierarchy = 'published_date'
    raw_id_fields = ('source',)
