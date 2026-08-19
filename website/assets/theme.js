/**
 * Apply the saved theme before first paint.
 *
 * Loaded from `<head>` without `defer` or `type="module"`, so it runs and
 * finishes before the browser paints anything and the page never flashes the
 * wrong colours. That is the only reason it is separate from `site.js`, which
 * is a module and therefore deferred.
 *
 * It lives in a file rather than inline in the page so that the site's
 * Content-Security-Policy can be `script-src 'self'`, with no `'unsafe-inline'`
 * for an attacker to hide an injected `<script>` behind.
 */

(function () {
  try {
    var stored = localStorage.getItem("baa-theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (error) {
    /* private mode: fall back to the media query */
  }
})();
