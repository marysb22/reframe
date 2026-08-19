const express = require("express");
const { requireAuth, requireSupervisor, asyncRoute } = require("../middleware/auth");
const {
    toStudentSummary,
    toProfileResponse,
    toRecord,
    toDocument,
    toMessage,
    toMaterial,
    toAnnouncement,
    computeProgressSummary,
} = require("../utils/serializers");
const { documentUpload, materialUpload } = require("../utils/uploads");
const { buildRecordsQuery, RECORD_TYPE_TABLES } = require("../utils/recordsQuery");

const router = express.Router();

router.use(requireAuth, requireSupervisor);

// GET /group — this supervisor's Master Trainer + teammate Trainer (ToT)
// + trainee count, all derived from group_id / primary_supervisor_id on
// the `supervisors` table (see database schema, SECTION 2).
router.get(
    "/group",
    asyncRoute(async(req, res, db) => {
        const { rows: selfRows } = await db.query(
            "SELECT group_id, supervisor_type, primary_supervisor_id FROM supervisors WHERE id = $1", [req.user.id]
        );
        const self = selfRows[0];

        if (!self || !self.group_id) {
            return res.json({
                groupLabel: "No Group assigned",
                masterTrainer: null,
                totTeammates: [],
                traineeCount: 0,
            });
        }

        const { rows: groupRows } = await db.query("SELECT name FROM groups WHERE id = $1", [self.group_id]);
        const groupLabel = groupRows[0] ?.name || "My Group";

        const { rows: memberRows } = await db.query(
            `SELECT uc.id, uc.member_code, sup.full_name, sup.email, sup.phone, sup.supervisor_type
       FROM supervisors sup
       JOIN user_credentials uc ON uc.id = sup.id
       WHERE sup.group_id = $1`, [self.group_id]
        );

        const masterRow = memberRows.find((m) => m.supervisor_type === "primary");
        const masterTrainer = masterRow ?
            {
                full_name: masterRow.full_name,
                memberCode: masterRow.member_code,
                email: masterRow.email,
                phone: masterRow.phone,
            } :
            null;

        const totTeammates = memberRows
            .filter((m) => m.supervisor_type === "in_training" && m.id !== req.user.id)
            .map((m) => ({
                full_name: m.full_name,
                memberCode: m.member_code,
                email: m.email,
                phone: m.phone,
            }));

        const { rows: countRows } = await db.query(
            "SELECT COUNT(*)::int AS count FROM students WHERE group_id = $1", [self.group_id]
        );

        res.json({
            groupLabel,
            masterTrainer,
            totTeammates,
            traineeCount: countRows[0].count,
        });
    })
);

module.exports = router;
