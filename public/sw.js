// Streams the preview copy and thumbnails straight from Google Drive to the editor,
// so playback doesn't pass through (or count against) the website's hosting.
var tok = null;

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

function token(force) {
  if (!force && tok && tok.expires_at > Date.now() + 60000) return Promise.resolve(tok.access_token);
  return fetch("/api/drive-token", { credentials: "same-origin" }).then(function (r) {
    if (!r.ok) throw new Error("auth");
    return r.json();
  }).then(function (j) { tok = j; return j.access_token; });
}

self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin || u.pathname.indexOf("/media/") !== 0) return;
  e.respondWith(media(e.request, u));
});

var CHUNK = 8 * 1024 * 1024;

function media(req, u) {
  var id = u.pathname.split("/")[2];
  var size = +u.searchParams.get("size") || 0;
  var type = u.searchParams.get("type") || "application/octet-stream";
  var range = req.headers.get("range");
  var start = 0, end = null, partial = false;
  if (range && size) {
    var m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      partial = true;
      if (m[1] === "" && m[2] !== "") { start = Math.max(0, size - +m[2]); end = size - 1; }
      else {
        start = +m[1] || 0;
        end = m[2] !== "" ? Math.min(+m[2], size - 1) : Math.min(size - 1, start + CHUNK - 1);
      }
      if (start >= size) return Promise.resolve(new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } }));
    }
  }
  var go = function (force) {
    return token(force).then(function (t) {
      // mediaBase is only set by the local test bench
      var url = tok && tok.mediaBase ? tok.mediaBase + encodeURIComponent(id) : "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?alt=media&supportsAllDrives=true";
      var h = { Authorization: "Bearer " + t };
      if (partial) h.Range = "bytes=" + start + "-" + end;
      return fetch(url, { headers: h });
    });
  };
  return go(false).then(function (r) {
    return r.status === 401 ? go(true) : r;
  }).then(function (r) {
    if (partial && r.status === 206) {
      return new Response(r.body, { status: 206, headers: {
        "Content-Type": type, "Accept-Ranges": "bytes",
        "Content-Range": "bytes " + start + "-" + end + "/" + size,
        "Content-Length": String(end - start + 1)
      } });
    }
    if (r.ok) {
      var h = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
      if (size) h["Content-Length"] = String(size);
      return new Response(r.body, { status: 200, headers: h });
    }
    return new Response(null, { status: r.status });
  }, function () { return new Response(null, { status: 503 }); });
}
