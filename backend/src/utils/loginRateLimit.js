// In-memory login attempt limiter -- no rate limiting existed on /login at
// all (unlike forgot-password/reset-code, which already have DB-backed
// per-user/per-IP/per-code caps -- see passwordReset.js). In-memory rather
// than a new table: this app runs as a single Node process, matches the
// "no new dependency" convention passwordReset.js already established,
// and a reset on server restart is an acceptable tradeoff for this scale.
//
// Keyed by IP + the attempted member code together, not either alone --
// per-IP alone would risk blocking a shared network (a school, an office)
// with many legitimate accounts; per-account alone is trivially bypassed
// by rotating IPs. Combining both still stops the realistic case (one
// attacker guessing passwords for one account) without collaterally
// locking out everyone behind the same IP.

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

const attempts = new Map(); // key -> array of failure timestamps (ms)

function keyFor(ip, memberCode) {
  return `${ip}:${String(memberCode || "").trim().toUpperCase()}`;
}

function prune(timestamps, now) {
  return timestamps.filter((t) => now - t < WINDOW_MS);
}

/** Returns { blocked: boolean, retryAfterSeconds? } without recording anything. */
function checkLoginRateLimit(ip, memberCode) {
  const key = keyFor(ip, memberCode);
  const now = Date.now();
  const existing = prune(attempts.get(key) || [], now);
  attempts.set(key, existing);
  if (existing.length >= MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil((WINDOW_MS - (now - existing[0])) / 1000);
    return { blocked: true, retryAfterSeconds };
  }
  return { blocked: false };
}

function recordFailedLogin(ip, memberCode) {
  const key = keyFor(ip, memberCode);
  const now = Date.now();
  const existing = prune(attempts.get(key) || [], now);
  existing.push(now);
  attempts.set(key, existing);
}

function clearLoginAttempts(ip, memberCode) {
  attempts.delete(keyFor(ip, memberCode));
}

module.exports = { checkLoginRateLimit, recordFailedLogin, clearLoginAttempts };
