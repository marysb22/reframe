/** Lowercase, ASCII-only, dash-separated slug. Non-Latin script (e.g. Arabic-only
 * titles) has nothing to transliterate and collapses to "" -- callers should
 * fall back to another source string (or an id-based slug) when that happens. */
function slugify(text) {
  if (!text) return "";
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

module.exports = { slugify };
