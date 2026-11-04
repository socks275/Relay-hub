/* Pine service worker — routes Scramjet-namespaced requests to the
 * Scramjet controller living in the hub page. Everything else passes
 * through untouched. Scoped to / so proxied pages can live under it. */
importScripts("/controller/controller.sw.js");

addEventListener("fetch", (e) => {
  if ($scramjetController.shouldRoute(e)) {
    e.respondWith($scramjetController.route(e));
  }
});
