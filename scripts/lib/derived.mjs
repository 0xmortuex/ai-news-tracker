// The Phase 2 output files derived from one news.json: releases, digests (+ markdown),
// status. Pure: returns file name -> text; the caller validates and writes them.

import { deriveReleases, buildReleases } from './releases.mjs';
import { buildDigest, renderDigestMarkdown } from './digest.mjs';
import { buildStatus } from './status.mjs';

function utcDay(iso) { return String(iso).slice(0, 10); }

// prev: { releases, digestWeekly } previous published objects (or null).
// opts.forceWeekly: regenerate the weekly digest even if today's already exists.
export function buildDerived({ news, sources, pool, prev = {}, forceWeekly = false }) {
  const nowMs = Date.parse(news.generatedAt);
  const releases = buildReleases(deriveReleases(news.items, sources), prev.releases || null, nowMs, news.generatedAt);
  const daily = buildDigest(news, 'daily');
  let weekly = buildDigest(news, 'weekly');
  let weeklyReused = false;
  const pw = prev.digestWeekly;
  if (!forceWeekly && pw && pw.schema === weekly.schema && pw.period && pw.period.kind === 'weekly' && utcDay(pw.generatedAt) === utcDay(news.generatedAt)) {
    weekly = pw; // the weekly digest is regenerated once per UTC day
    weeklyReused = true;
  }
  const status = buildStatus(pool || [], sources, nowMs, news.generatedAt);
  const dailyText = JSON.stringify(daily) + '\n';
  return {
    objects: { releases, daily, weekly, status },
    weeklyReused,
    files: {
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
