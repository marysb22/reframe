const db = require("../../db");
const config = require("../config");

function generateNextId(prefix = config.idPrefix, padLength = config.idPadLength) {
  const tx = db.transaction((p) => {
    const row = db.prepare("SELECT last_number FROM id_counters WHERE prefix = ?").get(p);

    const nextNumber = (row ? row.last_number : 0) + 1;

    if (row) {
      db.prepare("UPDATE id_counters SET last_number = ? WHERE prefix = ?").run(nextNumber, p);
    } else {
      db.prepare("INSERT INTO id_counters (prefix, last_number) VALUES (?, ?)").run(p, nextNumber);
    }

    return nextNumber;
  });

  const number = tx(prefix);
  const padded = String(number).padStart(padLength, "0");
  return `${prefix}${padded}`;
}

module.exports = { generateNextId };
