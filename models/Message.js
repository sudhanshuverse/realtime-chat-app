const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  room: String,
  sender: String,
  text: String,
  status: {
    type: String,
    enum: ['sent', 'delivered', 'seen'],
    default: 'sent'
  },
  deleted: { type: Boolean, default: false },
  reactions: [{
    user: String,
    emoji: String
  }],
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Message', messageSchema);
