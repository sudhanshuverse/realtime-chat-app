const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, trim: true },
  password: String,
  online: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now },
  avatar: String
});

module.exports = mongoose.model('User', userSchema);
