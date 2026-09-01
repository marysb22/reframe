// One-off backfill: fixes existing Trainees whose supervisor_students links
// predate the "Group is the source of truth" change to admin.js -- every
// Trainee should be linked to their Group's whole current team (Master
// Trainer + every Trainer/ToT), not just whichever ones were individually
// picked at creation time. New writes already do this going forward; this
// script catches up any group/trainee combination created before that.
//
// Purely additive and idempotent -- only ever INSERTs a link that's
// missing (ON DUPLICATE KEY UPDATE), never deletes or changes an existing
// row. Safe to re-run.
//
// Usage:
//   node backend/scripts/backfill-group-supervisor-links.js          (dry run -- reports what it WOULD insert)
//   node backend/scripts/backfill-group-supervisor-links.js --apply  (actually inserts)
// Uses the same DATABASE_URL the app itself connects with (via ../src/db).

const { pool } = require("../src/db");

async function main() {
  const apply = process.argv.includes("--apply");

  const { rows: groups } = await pool.query("SELECT id, name FROM trainer_groups ORDER BY id");

  let totalMissing = 0;

  for (const group of groups) {
    const { rows: team } = await pool.query("SELECT id FROM supervisors WHERE group_id = ?", [group.id]);
    const { rows: trainees } = await pool.query("SELECT id FROM students WHERE group_id = ?", [group.id]);
    if (!team.length || !trainees.length) continue;

    const { rows: existing } = await pool.query(
      `SELECT supervisor_id, student_id FROM supervisor_students WHERE student_id IN (${trainees
        .map(() => "?")
        .join(",")})`,
      trainees.map((t) => t.id)
    );
    const existingSet = new Set(existing.map((r) => `${r.supervisor_id}:${r.student_id}`));

    let missingForGroup = 0;
    for (const trainee of trainees) {
      for (const supervisor of team) {
        if (existingSet.has(`${supervisor.id}:${trainee.id}`)) continue;
        missingForGroup += 1;
        totalMissing += 1;
        if (apply) {
          await pool.query(
            `INSERT INTO supervisor_students (supervisor_id, student_id, assigned_by) VALUES (?, ?, NULL)
             ON DUPLICATE KEY UPDATE assigned_at = assigned_at`,
            [supervisor.id, trainee.id]
          );
        }
      }
    }
    if (missingForGroup) {
      console.log(
        `Group "${group.name}" (#${group.id}): ${missingForGroup} link(s) ${
          apply ? "inserted" : "missing"
        } across ${team.length} supervisor(s) x ${trainees.length} trainee(s)`
      );
    }
  }

  console.log(
    `\n${apply ? "Inserted" : "Would insert"} ${totalMissing} missing supervisor_students link(s) total across ${groups.length} group(s).`
  );
  if (!apply) {
    console.log("Dry run only -- re-run with --apply to actually insert these links.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
