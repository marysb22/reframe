const bcryptjs = require("bcryptjs");
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    const hash = await bcryptjs.hash("password123", 10);
    const updateResult = await pool.query(
      "UPDATE user_credentials SET password_hash = $1",
      [hash]
    );
    console.log("STEP 1 - ROWS UPDATED:", updateResult.rowCount);

    const checkResult = await pool.query(
      "SELECT member_code, LEFT(password_hash, 15) as preview FROM user_credentials"
    );
    console.log("STEP 2 - VERIFICATION:");
    console.table(checkResult.rows);

    console.log("DONE. All accounts now use password: password123");
    process.exit(0);
  } catch (err) {
    console.log("ERROR:", err.message);
    process.exit(1);
  }
})();
