// Pantry Shelf service worker: lets the app open from the home screen without a connection
// (showing the shelf as it was last loaded) and shows phone notifications.
const SHELL = "pantry-shell-2.14.0";
const DATA = "pantry-data";
const FILES = ["/", "/styles.css?v=2.14", "/app.js?v=2.14", "/vendor/qrcode.js", "/vendor/jsQR.js", "/vendor/zxing.min.js",
  "/default-cover.jpg?v=1", "/icon-192.png", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pantry-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  // The shelf itself: always fresh when online, the last copy when offline
  if (url.pathname === "/api/state") {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put("/api/state", copy)); }
      return res;
    }).catch(async () => {
      const hit = await caches.match("/api/state", { cacheName: DATA });
      if (!hit) return Response.json({ error: "offline" }, { status: 503 });
      const data = await hit.json();
      return Response.json({ ...data, offline: true, savedAt: Date.parse(hit.headers.get("date")) || null });
    }));
    return;
  }
  if (url.pathname === "/api/session") {
    e.respondWith(fetch(req).catch(async () => {
      const ok = await caches.match("/api/state", { cacheName: DATA });
      return ok ? Response.json({ ok: true, offline: true, passwordProtected: true }) : Response.json({ error: "offline" }, { status: 503 });
    }));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;

  // Pages: the network first, so updates show up right away
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/", { cacheName: SHELL })));
    return;
  }
  // Scripts, styles and icons: the saved copy first (file names change with each version)
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && (url.pathname === "/cover.jpg" || FILES.includes(url.pathname + url.search))) {
      const copy = res.clone(); caches.open(url.pathname === "/cover.jpg" ? DATA : SHELL).then((c) => c.put(req, copy));
    }
    return res;
  })));
});

self.addEventListener("push", (e) => {
  let msg = {};
  try { msg = e.data.json(); } catch { msg = { title: "Pantry Shelf", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(msg.title || "Pantry Shelf", {
    body: msg.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: "pantry-reminder", renotify: true, data: { url: msg.url || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(location.origin));
    return win ? win.focus() : self.clients.openWindow(target);
  }));
});
