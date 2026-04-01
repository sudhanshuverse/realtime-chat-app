const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || "chat_secret_key_change_in_production";

function generateToken(user) {
  return jwt.sign({ username: user.username }, SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { generateToken, verifyToken };
