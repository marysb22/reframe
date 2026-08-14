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
  console.log("\n" + check.file + "  (" + check.description + ")");

  if (!fs.existsSync(fullPath)) {
    console.log("  FILE DOES NOT EXIST AT ALL: " + fullPath);
    allPassed = false;
    continue;
  }

  const content = fs.readFileSync(fullPath, "utf8");
  for (const marker of check.mustContain) {
    const found = content.includes(marker);
    console.log("  " + (found ? "PASS" : "FAIL") + " contains: " + marker);
    if (!found) allPassed = false;
  }
}

console.log("\n" + "=".repeat(70));
if (allPassed) {
  console.log("ALL FILES ARE UP TO DATE.");
  console.log("If the dashboard still shows blank names/dates, the running");
  console.log("server was started BEFORE these files were saved -- restart it:");
  console.log("   Stop-Process -Name node -Force");
  console.log("   node src\\server.js");
} else {
  console.log("AT LEAST ONE FILE IS OUT OF DATE -- see FAIL lines above.");
  console.log("Re-download that file and overwrite it completely.");
}
console.log("=".repeat(70));
