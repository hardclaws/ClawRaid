/* =========================================================================
 * Optional pre-filled Client ID for self-hosters.
 *
 * By default every user supplies their OWN Twitch Client ID (recommended and
 * ToS-friendly). But if you self-host this dock on your own domain and want to
 * spare your users the copy/paste step, you can drop a Client ID here.
 *
 * HOW:  copy this file to `config.js` and fill in the value below, then commit
 *       `config.js` instead of `config.example.js`.
 *
 * WARNING: a Client ID alone is NOT a secret (it's public in any web request),
 *          but publishing one that many people hammer will hit Twitch rate
 *          limits and can get the app suspended. Per-user setup is preferred.
 *          Never put your Client SECRET here — this is a client-only app.
 * ========================================================================= */
window.RD_CONFIG = {
  clientId: "", // e.g. "hof5gwx0su6owfn0nyan9c87zr6t"
};
