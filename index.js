const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('./models/User');
const Message = require('./models/Message');
const { generateToken, verifyToken } = require('./utils/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const DB_PATH = "mongodb://root:root@ac-u0nafti-shard-00-00.r9jtfbr.mongodb.net:27017,ac-u0nafti-shard-00-01.r9jtfbr.mongodb.net:27017,ac-u0nafti-shard-00-02.r9jtfbr.mongodb.net:27017/file?ssl=true&replicaSet=atlas-dvojmu-shard-0&authSource=admin&appName=Practice";


// DB
mongoose.connect('mongodb://127.0.0.1:27017/chat-app')
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log("DB Error:", err));

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));


// ─── ROUTES ───────────────────────────────────────────────

app.get('/', (req, res) => res.render('home'));

app.get('/login', (req, res) => res.render('login'));

app.get('/signup', (req, res) => res.render('signup'));

app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.json({ error: 'Username and password required' });

    const exists = await User.findOne({ username });
    if (exists) return res.json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    await User.create({ username, password: hash });
    res.json({ success: true });
  } catch (e) {
    res.json({ error: 'Registration failed' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.json({ error: 'Wrong password' });

    const token = generateToken(user);
    res.json({ success: true, token, username });
  } catch (e) {
    res.json({ error: 'Login failed' });
  }
});

app.get('/chat', (req, res) => {
  const { token, username } = req.query;
  if (!token) return res.redirect('/');
  try {
    verifyToken(token);
    res.render('chat', { token, username });
  } catch {
    res.redirect('/');
  }
});

// ─── SOCKET AUTH ──────────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("No token"));
  try {
    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

// ─── SOCKET LOGIC ─────────────────────────────────────────

let onlineUsers = {}; // { username: socketId }
let typingUsers = {}; // { room: Set<username> }

io.on('connection', async (socket) => {
  const username = socket.user.username;
  onlineUsers[username] = socket.id;

  // Update user's lastSeen & online status
  await User.findOneAndUpdate({ username }, { online: true, lastSeen: new Date() });

  io.emit('online-users', Object.keys(onlineUsers));

  // ── Join room ──────────────────────────────────────────
  socket.on('join-room', async (room) => {
    // Leave previous room
    if (socket.room) {
      socket.leave(socket.room);
      // Remove typing indicator
      if (typingUsers[socket.room]) {
        typingUsers[socket.room].delete(username);
        io.to(socket.room).emit('typing-update', [...(typingUsers[socket.room] || [])]);
      }
    }

    socket.join(room);
    socket.room = room;

    // Mark all unread messages in this room as delivered
    await Message.updateMany(
      { room, sender: { $ne: username }, status: 'sent' },
      { status: 'delivered' }
    );

    const messages = await Message.find({ room }).sort({ timestamp: 1 }).limit(100);
    socket.emit('chat-history', messages);

    // Notify room members
    io.to(room).emit('user-joined', { username, room });
  });

  // ── Send message ───────────────────────────────────────
  socket.on('send-message', async ({ text, replyTo }) => {
    if (!socket.room || !text?.trim()) return;

    // Clear typing
    if (typingUsers[socket.room]) {
      typingUsers[socket.room].delete(username);
      io.to(socket.room).emit('typing-update', [...typingUsers[socket.room]]);
    }

    const msgData = {
      room: socket.room,
      sender: username,
      text: text.trim(),
      status: 'sent'
    };
    if (replyTo) msgData.replyTo = replyTo;

    const msg = await Message.create(msgData);
    const populated = await Message.findById(msg._id).populate('replyTo');

    io.to(socket.room).emit('message', populated);

    // Auto-mark delivered for users in room (except sender)
    const socketsInRoom = await io.in(socket.room).fetchSockets();
    for (const s of socketsInRoom) {
      if (s.user?.username !== username) {
        await Message.findByIdAndUpdate(msg._id, { status: 'delivered' });
        io.to(socket.room).emit('message-status-update', { id: msg._id, status: 'delivered' });
        break;
      }
    }
  });

  // ── Typing ─────────────────────────────────────────────
  socket.on('typing', (isTyping) => {
    if (!socket.room) return;
    if (!typingUsers[socket.room]) typingUsers[socket.room] = new Set();

    if (isTyping) typingUsers[socket.room].add(username);
    else typingUsers[socket.room].delete(username);

    socket.to(socket.room).emit('typing-update', [...typingUsers[socket.room]]);
  });

  // ── Message seen ──────────────────────────────────────
  socket.on('message-seen', async (ids) => {
    const idList = Array.isArray(ids) ? ids : [ids];
    await Message.updateMany(
      { _id: { $in: idList }, sender: { $ne: username } },
      { status: 'seen' }
    );
    idList.forEach(id => {
      io.to(socket.room).emit('message-status-update', { id, status: 'seen' });
    });
  });

  // ── React to message ──────────────────────────────────
  socket.on('react-message', async ({ messageId, emoji }) => {
    const msg = await Message.findById(messageId);
    if (!msg) return;

    const existing = msg.reactions.find(r => r.user === username);
    if (existing) {
      if (existing.emoji === emoji) {
        msg.reactions = msg.reactions.filter(r => r.user !== username);
      } else {
        existing.emoji = emoji;
      }
    } else {
      msg.reactions.push({ user: username, emoji });
    }
    await msg.save();
    io.to(socket.room).emit('reaction-update', { messageId, reactions: msg.reactions });
  });

  // ── Delete message ─────────────────────────────────────
  socket.on('delete-message', async (messageId) => {
    const msg = await Message.findById(messageId);
    if (!msg || msg.sender !== username) return;
    msg.deleted = true;
    msg.text = 'This message was deleted';
    await msg.save();
    io.to(socket.room).emit('message-deleted', messageId);
  });

  // ── Disconnect ────────────────────────────────────────
  socket.on('disconnect', async () => {
    delete onlineUsers[username];
    if (socket.room && typingUsers[socket.room]) {
      typingUsers[socket.room].delete(username);
      io.to(socket.room).emit('typing-update', [...(typingUsers[socket.room] || [])]);
    }
    await User.findOneAndUpdate({ username }, { online: false, lastSeen: new Date() });
    io.emit('online-users', Object.keys(onlineUsers));
  });
});

server.listen(4000, () => {
  console.log("🚀 Server running at http://localhost:8000");
});