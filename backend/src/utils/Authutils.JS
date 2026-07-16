const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("../config");

const SALT_ROUNDS = 12;

function hashPassword(plainPassword) {
  return bcrypt.hashSync(plainPassword, SALT_ROUNDS);
}

function verifyPassword(plainPassword, hash) {
  return bcrypt.compareSync(plainPassword, hash);
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, member_code: user.member_code },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

function generateTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, generateTempPassword };
