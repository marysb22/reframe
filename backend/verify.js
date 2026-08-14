// Run with: node verify-setup.js
// (from inside the backend folder)
//
// Checks every fix delivered so far is ACTUALLY present in the files on
// disk, and reports pass/fail for each -- removes the guesswork around
// "did I actually replace this file" that's caused most of the issues
// reported so far.

const fs = require("fs");
const path = require("path");

const checks = [
  {
    file: "src/utils/serializers.js",
    mustContain: ["full_name: row.full_name", "created_at: row.created_at", "supervisors: row.supervisors"],
    description: "Name/date field-naming fix + supervisor list on student accounts",
  },
  {
    file: "src/routes/admin.js",
    mustContain: ["st.gender, st.date_of_birth", "students/:id/profile", "documents/:id"],
    description: "Full Student Profile endpoint + personal-info columns + document deletion",
  },
  {
    file: "src/server.js",
    mustContain: ["res.on(\"finish\"", "cors("],
    description: "CORS + response-status logging",
  },
];

console.log("=".repeat(70));
console.log("VERIFYING BACKEND FILES ON DISK");
console.log("=".repeat(70));

let allPassed = true;

for (const check of checks) {
  const fullPath = path.join(__dirname, check.file);
  console.log(`\n${check.file}  (${check.description})`);

  if (!fs.existsSync(fullPath)) {
    console.log(`  ❌ FILE DOES NOT EXIST AT ALL: ${fullPath}`);
    allPassed = false;
    continue;
  }

  const content = fs.readFileSync(fullPath, "utf8");
  for (const marker of check.mustContain) {
    const found = content.includes(marker);
    console.log(`  ${found ? "✅" : "❌"} contains "${marker}"`);
    if (!found) allPassed = false;
  }
}

console.log("\n" + "=".repeat(70));
if (allPassed) {
  console.log("✅ ALL FILES ARE UP TO DATE.");
  console.log("If the dashboard still shows blank names/dates after this,");
  console.log("the server process running right now was started BEFORE these");
  console.log("files were saved -- stop it completely and start it again:");
  console.log("   Stop-Process -Name node -Force");
  console.log("   node src\\server.js");
} else {
  console.log("❌ AT LEAST ONE FILE IS OUT OF DATE.");
  console.log("Re-download the failing file(s) from the conversation and");
  console.log("overwrite them completely, then run this script again before");
  console.log("restarting the server.");
}
console.log("=".repeat(70));