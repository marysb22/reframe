const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../src/config");

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new Database(config.dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

module.exports = db;
