from django.urls import path
from . import views

app_name = 'newsfeed'

urlpatterns = [
    path('', views.feed, name='feed'),
    path('read/<int:article_id>/', views.mark_read, name='mark_read'),
    path('read-all/', views.mark_all_read, name='mark_all_read'),
    path('fetch-now/', views.fetch_now, name='fetch_now'),
]
