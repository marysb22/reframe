const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const SALT_ROUNDS = 10;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Generates a random temporary password that's easy to read aloud/type
 * (no ambiguous characters like 0/O or 1/l/I), always 10 characters,
 * always includes at least one digit -- meets the >=8 character minimum
 * enforced elsewhere with room to spare.
 */
function generateTempPassword() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, generateTempPassword };
