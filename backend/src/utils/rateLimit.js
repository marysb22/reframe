// Generic in-memory rate limiter -- same idiom as loginRateLimit.js (single
// Node process, no new dependency, a reset on server restart is acceptable
// at this app's scale), generalized to any key/window/cap instead of being
// login-specific. First use: Library's online-search proxy (routes/
// library.js), which forwards every call to Crossref -- with nothing
// capping it, one account (or a compromised token) could hammer that
// external API fast enough to get this server's own IP rate-limited or
// blocked by Crossref, breaking the lookup for every user, not just the
// caller.
const buckets = new Map(); // key -> array of call timestamps (ms)

function prune(timestamps, windowMs, now) {
  return timestamps.filter((t) => now - t < windowMs);
}

/**
 * Returns { blocked: boolean, retryAfterSeconds? } and, if not blocked,
 * records this call. Call once per request, right before doing the actual
 * work -- there is no separate "check" step, unlike loginRateLimit's
 * check/record split (that one only records on a *failed* login; this one
 * has no such distinction, every call counts).
 */
function checkAndRecord(key, { max, windowMs }) {
  const now = Date.now();
  const existing = prune(buckets.get(key) || [], windowMs, now);
  if (existing.length >= max) {
    buckets.set(key, existing);
    const retryAfterSeconds = Math.ceil((windowMs - (now - existing[0])) / 1000);
    return { blocked: true, retryAfterSeconds };
  }
  existing.push(now);
  buckets.set(key, existing);
  return { blocked: false };
}

module.exports = { checkAndRecord };
