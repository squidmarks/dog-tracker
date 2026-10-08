// Service worker: shows native notifications when the server pushes an alert, and opens the app when one is tapped.
// iOS requires every push to display a notification, so this always calls showNotification.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "Dog Tracker", {
      body: data.body || "",
      icon: "/apple-icon",
      badge: "/icon",
      tag: data.tag || undefined,      // a repeat of the same alert replaces the earlier banner
      renotify: !!data.tag,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) if ("focus" in w) return w.focus();
      return self.clients.openWindow(url);
    }),
  );
});
