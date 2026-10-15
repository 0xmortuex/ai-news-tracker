from datetime import timedelta
from urllib.parse import urlparse
from django.shortcuts import render, get_object_or_404, redirect
from django.http import HttpResponseRedirect, JsonResponse
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_http_methods, require_POST
from django.contrib import messages
from django.db.models import Q
from .models import Article, Source
from .fetcher import fetch_all_sources


def _domain(url):
    try:
        return urlparse(url).netloc
    except Exception:
        return ''


def feed(request):
    country = request.GET.get('country', '').strip()
    source_id = request.GET.get('source', '').strip()
    source_type = request.GET.get('source_type', '').strip()
    query = request.GET.get('q', '').strip()
    show_read = request.GET.get('show_read') == 'on'
    error = request.GET.get('error', '').strip()

    articles = Article.objects.select_related('source').all()

    if not show_read:
        articles = articles.filter(is_read=False)
    if country:
        articles = articles.filter(source__country=country)
    if source_type:
        articles = articles.filter(source__source_type=source_type)
    if source_id:
        articles = articles.filter(source_id=source_id)
    if query:
        articles = articles.filter(
            Q(title__icontains=query) | Q(summary__icontains=query)
        )

    articles = list(articles[:200])
    new_cutoff = timezone.now() - timedelta(hours=1)
    for a in articles:
        a.domain = _domain(a.url) or _domain(a.source.url)
        a.is_new = a.published_date >= new_cutoff

    unread_count = Article.objects.filter(is_read=False).count()
    total_count = Article.objects.count()
    sources = Source.objects.filter(is_active=True).order_by('name')

    context = {
        'articles': articles,
        'unread_count': unread_count,
        'total_count': total_count,
        'sources': sources,
        'country_choices': Source.COUNTRY_CHOICES,
        'source_type_choices': Source.SOURCE_TYPE_CHOICES,
        'selected_country': country,
        'selected_source': source_id,
        'selected_source_type': source_type,
        'query': query,
        'show_read': show_read,
        'error': error,
    }
    return render(request, 'newsfeed/feed.html', context)


@require_http_methods(["GET", "POST"])
def mark_read(request, article_id):
    article = get_object_or_404(Article, pk=article_id)
    target = (article.url or '').strip()

    if not (target.startswith('http://') or target.startswith('https://')):
        messages.error(request, 'Invalid article URL')
        return HttpResponseRedirect(reverse('newsfeed:feed'))

    if not article.is_read:
        article.is_read = True
        article.save(update_fields=['is_read'])

    return HttpResponseRedirect(target)


@require_POST
def mark_all_read(request):
    Article.objects.filter(is_read=False).update(is_read=True)
    return redirect('newsfeed:feed')


@require_POST
def fetch_now(request):
    summary = fetch_all_sources()
    return JsonResponse({
        'new': summary['total_new'],
        'checked': summary['sources_checked'],
        'errors': summary['errors'],
    })
