const bcryptjs = require("bcryptjs");
const mysql = require("mysql2/promise");
require("dotenv").config();

(async () => {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL });
  try {
    const hash = await bcryptjs.hash("password123", 10);
    const [updateResult] = await pool.query(
      "UPDATE user_credentials SET password_hash = ?",
      [hash]
    );
    console.log("STEP 1 - ROWS UPDATED:", updateResult.affectedRows);

    const [checkResult] = await pool.query(
      "SELECT member_code, LEFT(password_hash, 15) as preview FROM user_credentials"
    );
    console.log("STEP 2 - VERIFICATION:");
    console.table(checkResult);

    console.log("DONE. All accounts now use password: password123");
    process.exit(0);
  } catch (err) {
    console.log("ERROR:", err.message);
    process.exit(1);
  }
})();
