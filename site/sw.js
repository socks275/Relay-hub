/* Relay Hub — service worker.
 *
 * One job: hand every Scramjet-namespaced request to the Scramjet
 * controller running in the page, and let everything else through
 * untouched. Scoped to the site root so proxied pages can live beneath it. */
importScripts("controller/controller.sw.js");

self.addEventListener("fetch", (event) => {
  if ($scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
  }
});
