/**
 * Unit tests for the Guides tab pure logic (docs/guides-lib.js).
 *
 * Run from the repo root:   node --test docs/tests/
 *
 * Covers the two pieces the Guides expansion adds:
 *   - the Source filter dropdown (sourceCategory / matchesFilter / sourceBadge)
 *   - the aggregated fetch logic (dedupeByUrl / sortGuides / aggregateGuides)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const GuidesLib = require("../guides-lib.js");

// --- fixtures -------------------------------------------------------------
const blog = { source: "Simon Willison", url: "https://a.com/1", dateISO: "2026-05-10T00:00:00Z" };
const youtube = { source: "YouTube: Andrej Karpathy", url: "https://yt.com/v", published: "2026-05-12T00:00:00Z" };
const github = { source: "GitHub", url: "https://gh.com/r", dateISO: "2026-05-11T00:00:00Z" };
const ghDisc = { source: "GitHub Discussions: simonw/llm", url: "https://gh.com/d", dateISO: "2026-05-09T00:00:00Z" };
const reddit = { source: "r/ClaudeAI Top", url: "https://rd.com/p", dateISO: "2026-05-08T00:00:00Z" };
const hn = { source: "Hacker News AI", url: "https://hn.com/i", dateISO: "2026-05-07T00:00:00Z", excerpt: "120 points · 64 comments" };
const bsky = { source: "Bluesky: swyx", url: "https://bsky.com/p", dateISO: "2026-05-06T00:00:00Z" };
const devto = { source: "dev.to", url: "https://dev.to/x", dateISO: "2026-05-05T00:00:00Z" };
const trendshift = { source: "Trendshift", url: "https://ts.com/r", dateISO: "2026-05-04T00:00:00Z" };

// =========================================================================
// SOURCE FILTER DROPDOWN
// =========================================================================
test("sourceCategory buckets every source type correctly", () => {
  assert.equal(GuidesLib.sourceCategory(blog), "Blogs");
  assert.equal(GuidesLib.sourceCategory(youtube), "YouTube");
  assert.equal(GuidesLib.sourceCategory(github), "GitHub");
  assert.equal(GuidesLib.sourceCategory(ghDisc), "GitHub");
  assert.equal(GuidesLib.sourceCategory(reddit), "Reddit");
  assert.equal(GuidesLib.sourceCategory(hn), "HN");
  assert.equal(GuidesLib.sourceCategory(bsky), "Bluesky");
  assert.equal(GuidesLib.sourceCategory(devto), "Dev Communities");
  assert.equal(GuidesLib.sourceCategory(trendshift), "GitHub");
});

test("sourceCategory falls back to Blogs for unknown / empty sources", () => {
  assert.equal(GuidesLib.sourceCategory({ source: "Latent Space" }), "Blogs");
  assert.equal(GuidesLib.sourceCategory({}), "Blogs");
  assert.equal(GuidesLib.sourceCategory({ source: "" }), "Blogs");
});

test("matchesFilter: 'all' matches everything", () => {
  for (const it of [blog, youtube, github, reddit, hn, bsky, devto]) {
    assert.equal(GuidesLib.matchesFilter(it, "all"), true);
  }
});

test("matchesFilter narrows to the selected dropdown value", () => {
  assert.equal(GuidesLib.matchesFilter(youtube, "YouTube"), true);
  assert.equal(GuidesLib.matchesFilter(youtube, "Blogs"), false);
  assert.equal(GuidesLib.matchesFilter(reddit, "Reddit"), true);
  assert.equal(GuidesLib.matchesFilter(devto, "Dev Communities"), true);
  assert.equal(GuidesLib.matchesFilter(devto, "GitHub"), false);
});

test("FILTER_TYPES exposes exactly the eight dropdown options", () => {
  assert.deepEqual(GuidesLib.FILTER_TYPES, [
    "all", "Blogs", "YouTube", "GitHub", "Reddit", "HN", "Bluesky", "Dev Communities",
  ]);
});

test("sourceBadge produces readable labels", () => {
  assert.equal(GuidesLib.sourceBadge(blog), "Blog: Simon Willison");
  assert.equal(GuidesLib.sourceBadge(youtube), "YouTube");
  assert.equal(GuidesLib.sourceBadge(github), "GitHub");
  assert.equal(GuidesLib.sourceBadge(reddit), "r/ClaudeAI");
  assert.equal(GuidesLib.sourceBadge(hn), "HN");
  assert.equal(GuidesLib.sourceBadge(bsky), "Bluesky");
  assert.equal(GuidesLib.sourceBadge(devto), "dev.to");
  assert.equal(GuidesLib.sourceBadge(trendshift), "Trendshift");
});

// =========================================================================
// AGGREGATED FETCH LOGIC
// =========================================================================
test("dedupeByUrl drops repeated URLs, keeps first occurrence", () => {
  const dupes = [
    { url: "https://x.com/1", source: "A" },
    { url: "https://x.com/1", source: "B" },
    { url: "https://x.com/2", source: "C" },
  ];
  const out = GuidesLib.dedupeByUrl(dupes);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, "A"); // first kept
});

test("dedupeByUrl skips items with no URL", () => {
  const out = GuidesLib.dedupeByUrl([{ url: "" }, { source: "no url" }, { url: "https://ok.com" }]);
  assert.equal(out.length, 1);
});

test("sortGuides 'recent' sorts newest-first (mixed dateISO/published)", () => {
  const out = GuidesLib.sortGuides([reddit, youtube, blog], "recent");
  assert.deepEqual(out.map((i) => i.url), [youtube.url, blog.url, reddit.url]);
});

test("sortGuides 'discussed' ranks by comment count", () => {
  const a = { ...hn, url: "https://hn.com/a", excerpt: "10 comments" };
  const b = { ...hn, url: "https://hn.com/b", excerpt: "999 comments" };
  const out = GuidesLib.sortGuides([a, b, blog], "discussed");
  assert.equal(out[0].url, "https://hn.com/b");
  assert.equal(out[1].url, "https://hn.com/a");
});

test("sortGuides 'alpha' sorts by source name", () => {
  const out = GuidesLib.sortGuides([youtube, blog, github], "alpha");
  assert.deepEqual(out.map((i) => i.source), ["GitHub", "Simon Willison", "YouTube: Andrej Karpathy"]);
});

test("commentCount parses HN-style excerpts, 0 otherwise", () => {
  assert.equal(GuidesLib.commentCount(hn), 64);
  assert.equal(GuidesLib.commentCount({ excerpt: "1,204 comments" }), 1204);
  assert.equal(GuidesLib.commentCount(blog), 0);
});

test("aggregateGuides dedupes, sorts newest-first, and caps", () => {
  const raw = [reddit, youtube, blog, { ...blog }, github]; // blog duplicated by URL
  const out = GuidesLib.aggregateGuides(raw, 3);
  assert.equal(out.length, 3, "capped at limit");
  assert.equal(out[0].url, youtube.url, "newest first");
  const urls = out.map((i) => i.url);
  assert.equal(new Set(urls).size, urls.length, "no duplicate URLs");
});

test("aggregateGuides defaults to a 150-item cap", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    url: "https://x.com/" + i,
    source: "GitHub",
    dateISO: new Date(2026, 0, 1, 0, i).toISOString(),
  }));
  assert.equal(GuidesLib.aggregateGuides(many).length, 150);
});

// =========================================================================
// PERSONALIZATION ("Explain for me")
// =========================================================================
test("personalize is hidden by default — no ?personalize= param means null", () => {
  assert.equal(GuidesLib.extractPersonalizeParam("", "#/guides"), null);
  assert.equal(GuidesLib.extractPersonalizeParam("", ""), null);
  assert.equal(GuidesLib.extractPersonalizeParam("?q=ai", "#/news"), null);
});

test("personalize shows when ?personalize= is present (hash or search)", () => {
  assert.equal(
    GuidesLib.extractPersonalizeParam("", "#/guides?personalize=fadi-abc"),
    "fadi-abc"
  );
  assert.equal(
    GuidesLib.extractPersonalizeParam("?personalize=fadi-xyz", "#/guides"),
    "fadi-xyz"
  );
});

test("sha256Hex gates on the secret — matching value vs wrong value", async () => {
  const digest = await GuidesLib.sha256Hex("fadi-abc");
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await GuidesLib.sha256Hex("fadi-abc"), digest, "same input -> same hash");
  assert.notEqual(await GuidesLib.sha256Hex("fadi-wrong"), digest, "wrong input -> no match");
});

test("buildPersonalizeUrl encodes the guide URL and secret", () => {
  assert.equal(
    GuidesLib.buildPersonalizeUrl("https://w.dev/", "https://example.com/a?b=1", "fadi-s"),
    "https://w.dev/personalize?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&secret=fadi-s"
  );
});

test("button click triggers a fetch (mocked) and resolves the JSON answers", async () => {
  let requestedUrl = null;
  const mockFetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        url: "https://example.com/a",
        model: "google/gemini-flash-1.5",
        answers: { what_is_this: "a tool" },
      }),
    };
  };
  const out = await GuidesLib.fetchPersonalization(
    "https://w.dev",
    "https://example.com/a",
    "fadi-s",
    mockFetch
  );
  assert.ok(requestedUrl.startsWith("https://w.dev/personalize?url="), "fetch was called");
  assert.ok(requestedUrl.includes("secret=fadi-s"), "secret is forwarded");
  assert.equal(out.answers.what_is_this, "a tool");
});

test("fetchPersonalization surfaces the worker error on a non-OK response", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: "forbidden" }),
  });
  await assert.rejects(
    () => GuidesLib.fetchPersonalization("https://w.dev", "https://e.com/a", "bad", mockFetch),
    /forbidden/
  );
});

test("PERSONALIZE_QUESTIONS exposes the 5 questions in render order", () => {
  assert.deepEqual(
    GuidesLib.PERSONALIZE_QUESTIONS.map((q) => q.key),
    [
      "what_is_this",
      "how_does_it_work",
      "why_should_i_use_this",
      "difficulty_to_setup",
      "how_will_this_affect_me",
    ]
  );
});
