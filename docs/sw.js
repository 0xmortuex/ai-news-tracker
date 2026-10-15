/* Service worker for the AI News Tracker site.
 *
 * - App shell (index.html, guides-lib.js, manifest, icons): network first, the
 *   stored copy only when the network is unreachable.
 * - Data files (news.json, releases.json, digest*.json, guides.json): network
 *   first; the last good copy is stored, and served ONLY when the network fails
 *   or the answer is not a 200. A stored copy is returned with the header
 *   `x-offline-copy: <ISO time it was stored>` so the page can say
 *   "Offline copy from <time>".
 * - Failures (non-200, opaque, network errors) are never stored.
 * - Caches are versioned: bump VERSION and the old ones are deleted on activate.
 *
 * The decision logic is in plain functions at the top so tests/site-sw.test.mjs
 * can run them without a browser.
 */
"use strict";

var VERSION = "v1";
var SHELL_CACHE = "ai-news-shell-" + VERSION;
var DATA_CACHE = "ai-news-data-" + VERSION;
var SHELL_FILES = ["./", "index.html", "guides-lib.js", "manifest.webmanifest", "favicon.svg", "icons/icon-192.png", "icons/icon-512.png"];
var DATA_HOST = "raw.githubusercontent.com";
var DATA_PREFIX = "/0xmortuex/ai-news-tracker/data/";
var DATA_FILE = /(^|\/)(news|releases|guides|digest(-daily|-weekly)?)\.json$/;
var SHELL_FILE = /\/(index\.html|guides-lib\.js|manifest\.webmanifest|favicon\.svg|icons\/[A-Za-z0-9_.-]+)$/;

/** True for the published data files (the data branch or same-origin test copies). */
function isDataRequest(urlString, scopeOrigin) {
  var u;
  try { u = new URL(urlString); } catch (e) { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (!DATA_FILE.test(u.pathname)) return false;
  if (u.hostname === DATA_HOST) return u.pathname.indexOf(DATA_PREFIX) === 0;
  return u.origin === scopeOrigin;
}

/** True for same-origin app shell files (and the page itself). */
function isShellRequest(urlString, scopeOrigin, scopePath) {
  var u;
  try { u = new URL(urlString); } catch (e) { return false; }
  if (u.origin !== scopeOrigin) return false;
  if (DATA_FILE.test(u.pathname)) return false;
  var base = scopePath || "/";
  if (u.pathname === base || u.pathname === base.replace(/\/$/, "")) return true;
  return SHELL_FILE.test(u.pathname);
}

/** Only a complete 200 from a same-origin or CORS response may be stored. */
function isCacheable(resp) {
  return !!resp && resp.status === 200 && resp.ok === true && (resp.type === "basic" || resp.type === "cors" || resp.type === "default");
}

/** Which cache bucket names are current; everything else is deleted. */
function staleCacheNames(allNames) {
  return allNames.filter(function (n) {
    return n.indexOf("ai-news-") === 0 && n !== SHELL_CACHE && n !== DATA_CACHE;
  });
}

/** Header name/value that marks a response as an offline copy. */
function offlineHeaders(storedAtIso) {
  return { "x-offline-copy": storedAtIso, "x-cache-source": "service-worker" };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { VERSION: VERSION, SHELL_CACHE: SHELL_CACHE, DATA_CACHE: DATA_CACHE, SHELL_FILES: SHELL_FILES,
    isDataRequest: isDataRequest, isShellRequest: isShellRequest, isCacheable: isCacheable,
    staleCacheNames: staleCacheNames, offlineHeaders: offlineHeaders };
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function" && typeof caches !== "undefined") {
  var STAMP = "x-stored-at";

  self.addEventListener("install", function (event) {
    event.waitUntil(
      caches.open(SHELL_CACHE).then(function (c) {
        // Individual misses must not fail the install (e.g. a renamed icon).
        return Promise.all(SHELL_FILES.map(function (f) {
          return c.add(f).catch(function (e) { console.warn("[sw] precache miss", f, e && e.message); });
        }));
      }).then(function () { return self.skipWaiting(); })
    );
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      caches.keys().then(function (names) {
        return Promise.all(staleCacheNames(names).map(function (n) { return caches.delete(n); }));
      }).then(function () { return self.clients.claim(); })
    );
  });

  var storeData = function (request, response) {
    // Re-wrap with the time it was stored; the body is a clone, never the live stream.
    return response.clone().blob().then(function (body) {
      var headers = new Headers(response.headers);
      headers.set(STAMP, new Date().toISOString());
      return caches.open(DATA_CACHE).then(function (c) {
        return c.put(request.url, new Response(body, { status: 200, statusText: "OK", headers: headers }));
      });
    });
  };

  var serveStoredData = function (request) {
    return caches.open(DATA_CACHE).then(function (c) { return c.match(request.url); }).then(function (hit) {
      if (!hit) return null;
      var headers = new Headers(hit.headers);
      var at = headers.get(STAMP) || new Date(0).toISOString();
      var extra = offlineHeaders(at);
      Object.keys(extra).forEach(function (k) { headers.set(k, extra[k]); });
      return hit.blob().then(function (body) {
        return new Response(body, { status: 200, statusText: "OK", headers: headers });
      });
    });
  };

  var dataStrategy = function (request) {
    return fetch(request).then(function (resp) {
      if (isCacheable(resp)) {
        // Awaiting keeps the worker alive until the copy is stored.
        return storeData(request, resp).catch(function (e) { console.warn("[sw] not stored", e && e.message); }).then(function () { return resp; });
      }
      // A 404 means "not published"; do not mask it with an old copy. Server errors fall back.
      if (resp.status >= 500) {
        return serveStoredData(request).then(function (stored) { return stored || resp; });
      }
      return resp;
    }).catch(function (err) {
      return serveStoredData(request).then(function (stored) {
        if (stored) return stored;
        throw err;
      });
    });
  };

  var shellStrategy = function (request) {
    return fetch(request).then(function (resp) {
      if (isCacheable(resp)) {
        var copy = resp.clone();
        caches.open(SHELL_CACHE).then(function (c) { return c.put(request, copy); }).catch(function () {});
      }
      return resp;
    }).catch(function (err) {
      return caches.match(request, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (request.mode === "navigate") return caches.match("./").then(function (r) { if (r) return r; throw err; });
        throw err;
      });
    });
  };

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;
    var scope = self.registration && self.registration.scope ? new URL(self.registration.scope) : new URL(self.location.href);
    if (isDataRequest(request.url, scope.origin)) {
      event.respondWith(dataStrategy(request));
    } else if (isShellRequest(request.url, scope.origin, scope.pathname)) {
      event.respondWith(shellStrategy(request));
    }
    // Everything else (Worker proxies, fonts, ...) goes straight to the network.
  });
}
