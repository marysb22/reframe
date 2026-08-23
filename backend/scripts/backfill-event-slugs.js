// One-off backfill: assigns a unique `slug` to every existing `events` row
// that doesn't have one yet. Run this AFTER migration 001's STEP 1-2 (which
// add the nullable `slug` column) and BEFORE STEP 4 (which locks it down to
// NOT NULL + UNIQUE) -- see database/migrations/001_event_sections.sql.
//
// Usage: node backend/scripts/backfill-event-slugs.js
// Uses the same DATABASE_URL the app itself connects with (via ../src/config).

const { pool } = require("../src/db");
const { slugify } = require("../src/utils/slugify");

async function main() {
  const { rows } = await pool.query("SELECT id, title_en, title_ar, slug FROM events ORDER BY id");

  const used = new Set(rows.filter((r) => r.slug).map((r) => r.slug));
  let updated = 0;

  for (const row of rows) {
    if (row.slug) continue; // already has one, leave it alone

    let base = slugify(row.title_en) || slugify(row.title_ar) || `event-${row.id}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }

    await pool.query("UPDATE events SET slug = ? WHERE id = ?", [candidate, row.id]);
    used.add(candidate);
    updated += 1;
    console.log(`  #${row.id} -> ${candidate}`);
  }

  console.log(`\nDone. ${updated} row(s) assigned a slug, ${rows.length - updated} already had one.`);

  const { rows: stillNull } = await pool.query("SELECT COUNT(*) AS n FROM events WHERE slug IS NULL");
  if (Number(stillNull[0].n) > 0) {
    console.warn(
      `\nWARNING: ${stillNull[0].n} row(s) still have a NULL slug -- do NOT run migration STEP 4 yet.`
    );
    process.exitCode = 1;
  } else {
    console.log("\nAll rows have a slug. Safe to run migration 001 STEP 4 now.");
  }

  process.exit(process.exitCode || 0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
