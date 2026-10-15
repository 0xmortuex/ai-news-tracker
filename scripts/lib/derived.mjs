// The Phase 2 output files derived from one news.json: releases, digests (+ markdown),
// status. Pure: returns file name -> text; the caller validates and writes them.

import { deriveReleases, buildReleases } from './releases.mjs';
import { buildDigest, renderDigestMarkdown } from './digest.mjs';
import { buildStatus } from './status.mjs';
import { buildStories, buildEntities } from './stories.mjs';
import { buildTop, buildRss } from './feeds.mjs';

function utcDay(iso) { return String(iso).slice(0, 10); }

// prev: { releases, digestWeekly } previous published objects (or null).
// opts.forceWeekly: regenerate the weekly digest even if today's already exists.
export function buildDerived({ news, sources, pool, prev = {}, forceWeekly = false }) {
  const nowMs = Date.parse(news.generatedAt);
  const releases = buildReleases(deriveReleases(news.items, sources), prev.releases || null, nowMs, news.generatedAt);
  const stories = buildStories(news);
  const entities = buildEntities(stories);
  const top = buildTop(stories);
  const daily = buildDigest(news, 'daily', stories);
  let weekly = buildDigest(news, 'weekly', stories);
  let weeklyReused = false;
  const pw = prev.digestWeekly;
  // A weekly digest from before Phase 3 has no `top`: regenerate it instead of reusing it.
  if (!forceWeekly && pw && pw.schema === weekly.schema && pw.period && pw.period.kind === 'weekly' && Array.isArray(pw.top) && utcDay(pw.generatedAt) === utcDay(news.generatedAt)) {
    weekly = pw; // the weekly digest is regenerated once per UTC day
    weeklyReused = true;
  }
  const status = buildStatus(pool || [], sources, nowMs, news.generatedAt);
  const dailyText = JSON.stringify(daily) + '\n';
  return {
    objects: { releases, daily, weekly, status, stories, entities, top },
    weeklyReused,
    files: {
      'stories.json': JSON.stringify(stories) + '\n',
      'entities.json': JSON.stringify(entities) + '\n',
      'top.json': JSON.stringify(top) + '\n',
      'feed.rss': buildRss(stories),
      'releases.json': JSON.stringify(releases) + '\n',
      'digest-daily.json': dailyText,
      'digest.json': dailyText, // compatibility copy of the daily digest
      'digest-weekly.json': JSON.stringify(weekly) + '\n',
      'digest-daily.md': renderDigestMarkdown(daily),
      'digest-weekly.md': renderDigestMarkdown(weekly),
      'status.json': JSON.stringify(status) + '\n',
    },
  };
}
