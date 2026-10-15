"""
URL configuration for mysite project.
"""
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('', include('newsfeed.urls')),
    path('admin/', admin.site.urls),
]
