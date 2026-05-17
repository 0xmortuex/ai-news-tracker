/**
 * guides-lib.js — pure helpers for the AI News Tracker "Guides" tab.
 *
 * UMD: usable both as a browser global (window.GuidesLib) and as a
 * CommonJS module (require) so it can be unit-tested with `node --test`.
 *
 * Nothing here touches the DOM — keep it that way so it stays testable.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GuidesLib = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The eight buckets surfaced by the Guides "Source filter" dropdown.
  var FILTER_TYPES = [
    "all",
    "Blogs",
    "YouTube",
    "GitHub",
    "Reddit",
    "HN",
    "Bluesky",
    "Dev Communities",
  ];

  /**
   * Map a guide item to one of the FILTER_TYPES buckets, based on its
   * `source` string (the only field reliably present across every parser).
   */
  function sourceCategory(item) {
    var s = ((item && item.source) || "").toLowerCase().trim();
    if (!s) return "Blogs";
    if (s.indexOf("youtube") === 0) return "YouTube";
    if (s.indexOf("bluesky") === 0) return "Bluesky";
    if (s.indexOf("r/") === 0) return "Reddit";
    if (s.indexOf("hacker news") !== -1 || s === "hn") return "HN";
    if (s === "dev.to") return "Dev Communities";
    if (s === "github" || s.indexOf("github") === 0 || s === "trendshift") return "GitHub";
    // Personal blogs + newsletters (Latent Space, Ben's Bites, ...).
    return "Blogs";
  }

  /**
   * Human-facing badge label for an item — e.g. "Blog: Simon Willison",
   * "YouTube", "GitHub", "dev.to", "r/ClaudeAI".
   */
  function sourceBadge(item) {
    var cat = sourceCategory(item);
    var src = (item && item.source) || "";
    switch (cat) {
      case "YouTube":
        return "YouTube";
      case "Bluesky":
        return "Bluesky";
      case "Reddit":
        return src.split(" ")[0]; // "r/ClaudeAI" out of "r/ClaudeAI Top"
      case "HN":
        return "HN";
      case "Dev Communities":
        return "dev.to";
      case "GitHub":
        return src === "Trendshift" ? "Trendshift" : "GitHub";
      default:
        return "Blog: " + src;
    }
  }

  /** True if `item` should be shown under the given filter value. */
  function matchesFilter(item, filter) {
    return !filter || filter === "all" || sourceCategory(item) === filter;
  }

  /** Best-effort comment count, parsed from HN-style "N comments" excerpts. */
  function commentCount(item) {
    var m = /(\d[\d,]*)\s*comments?/i.exec((item && item.excerpt) || "");
    return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
  }

  function itemDate(item) {
    var t = new Date((item && (item.dateISO || item.published)) || 0).getTime();
    return isNaN(t) ? 0 : t;
  }

  /** Dedupe a flat item list by URL, keeping first occurrence. */
  function dedupeByUrl(items) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var url = ((items[i] && items[i].url) || "").trim();
      if (!url || seen[url]) continue;
      seen[url] = true;
      out.push(items[i]);
    }
    return out;
  }

  /**
   * Sort guide items by mode:
   *   "recent"    — newest first (default)
   *   "discussed" — most comments first, date as tie-breaker
   *   "alpha"     — alphabetical by source, then title
   */
  function sortGuides(items, mode) {
    var arr = items.slice();
    if (mode === "alpha") {
      arr.sort(function (a, b) {
        var s = ((a.source || "")).localeCompare(b.source || "");
        return s !== 0 ? s : (a.title || "").localeCompare(b.title || "");
      });
    } else if (mode === "discussed") {
      arr.sort(function (a, b) {
        var c = commentCount(b) - commentCount(a);
        return c !== 0 ? c : itemDate(b) - itemDate(a);
      });
    } else {
      arr.sort(function (a, b) {
        return itemDate(b) - itemDate(a);
      });
    }
    return arr;
  }

  /**
   * Full aggregation pipeline used by the Guides tab: dedupe by URL,
   * sort newest-first, cap at `limit` (default 150).
   */
  function aggregateGuides(items, limit) {
    var capped = typeof limit === "number" ? limit : 150;
    return sortGuides(dedupeByUrl(items || []), "recent").slice(0, capped);
  }

  // =========================================================================
  // PERSONALIZATION ("Explain for me")
  //
  // Pure helpers behind the hidden, secret-gated personalize feature. The DOM
  // wiring lives in index.html; everything testable lives here.
  // =========================================================================

  // The 5 questions answered per guide — key + display label, render order.
  var PERSONALIZE_QUESTIONS = [
    { key: "what_is_this", label: "What is this?" },
    { key: "how_does_it_work", label: "How does it work?" },
    { key: "why_should_i_use_this", label: "Why should I use this?" },
    { key: "difficulty_to_setup", label: "Difficulty to set up" },
    { key: "how_will_this_affect_me", label: "How will this affect me?" },
  ];

  /**
   * Pull the `personalize` value out of a location's search and/or hash.
   * The bookmark URL carries it after the hash (#/guides?personalize=...),
   * but a plain ?personalize= before the hash is accepted too.
   * Returns the raw value, or null when absent.
   */
  function extractPersonalizeParam(search, hash) {
    function probe(s) {
      if (!s) return null;
      var q = s.indexOf("?");
      if (q !== -1) s = s.slice(q + 1);
      try {
        return new URLSearchParams(s).get("personalize");
      } catch (e) {
        return null;
      }
    }
    return probe(search) || probe(hash) || null;
  }

  /** Build the worker /personalize request URL. */
  function buildPersonalizeUrl(workerBase, guideUrl, secret) {
    return (
      String(workerBase).replace(/\/+$/, "") +
      "/personalize?url=" +
      encodeURIComponent(guideUrl) +
      "&secret=" +
      encodeURIComponent(secret)
    );
  }

  /**
   * Fetch personalization JSON for one guide. Resolves to the parsed body;
   * rejects with the worker's error message on a non-OK response.
   */
  function fetchPersonalization(workerBase, guideUrl, secret, fetchImpl) {
    var f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!f) return Promise.reject(new Error("no fetch implementation available"));
    return f(buildPersonalizeUrl(workerBase, guideUrl, secret)).then(function (resp) {
      return resp.json().then(function (json) {
        if (!resp.ok) {
          throw new Error((json && json.error) || "HTTP " + resp.status);
        }
        return json;
      });
    });
  }

  /** SHA-256 hex digest of a string — works in the browser and Node 20+. */
  function sha256Hex(str) {
    var webcrypto =
      typeof globalThis !== "undefined" &&
      globalThis.crypto &&
      globalThis.crypto.subtle;
    if (!webcrypto) return Promise.reject(new Error("WebCrypto unavailable"));
    var bytes = new TextEncoder().encode(String(str));
    return webcrypto.digest("SHA-256", bytes).then(function (buf) {
      return Array.from(new Uint8Array(buf))
        .map(function (b) {
          return b.toString(16).padStart(2, "0");
        })
        .join("");
    });
  }

  return {
    FILTER_TYPES: FILTER_TYPES,
    sourceCategory: sourceCategory,
    sourceBadge: sourceBadge,
    matchesFilter: matchesFilter,
    commentCount: commentCount,
    dedupeByUrl: dedupeByUrl,
    sortGuides: sortGuides,
    aggregateGuides: aggregateGuides,
    PERSONALIZE_QUESTIONS: PERSONALIZE_QUESTIONS,
    extractPersonalizeParam: extractPersonalizeParam,
    buildPersonalizeUrl: buildPersonalizeUrl,
    fetchPersonalization: fetchPersonalization,
    sha256Hex: sha256Hex,
  };
});
