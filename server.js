const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// channels: { code: { name, createdBy, members: Map<socketId,{username,role}>, messages:[], voiceUsers: Set } }
const channels = {};

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── ADMIN: create channel ──
  socket.on('admin:create-channel', ({ channelName, secretCode, adminName }, cb) => {
    if (!channelName || !secretCode || !adminName)
      return cb({ ok: false, error: 'Missing fields.' });
    if (channels[secretCode])
      return cb({ ok: false, error: 'Code already in use. Choose another.' });

    channels[secretCode] = {
      name: channelName,
      createdBy: adminName,
      members: new Map(),
      messages: [],
      voiceUsers: new Set(),
      adminSocketId: socket.id
    };
    socket.join(secretCode);
    channels[secretCode].members.set(socket.id, { username: adminName, role: 'admin' });
    socket.data = { code: secretCode, username: adminName, role: 'admin' };

    console.log(`[ADMIN] "${adminName}" created "${channelName}" (${secretCode})`);
    cb({ ok: true, channel: { name: channelName, code: secretCode } });
    broadcastMembers(secretCode);
  });

  // ── USER: join channel ──
  socket.on('user:join-channel', ({ secretCode, username }, cb) => {
    if (!secretCode || !username)
      return cb({ ok: false, error: 'Missing fields.' });
    const ch = channels[secretCode];
    if (!ch)
      return cb({ ok: false, error: 'Invalid secret code. Ask the admin for the correct code.' });

    socket.join(secretCode);
    ch.members.set(socket.id, { username, role: 'user' });
    socket.data = { code: secretCode, username, role: 'user' };

    cb({ ok: true, channel: { name: ch.name, createdBy: ch.createdBy }, history: ch.messages.slice(-100) });
    broadcastMembers(secretCode);
    socket.to(secretCode).emit('chat:system', { text: `${username} joined the channel`, ts: Date.now() });
    console.log(`[JOIN] "${username}" → "${ch.name}"`);
  });

  // ── TEXT message ──
  socket.on('chat:message', ({ text }, cb) => {
    const { code, username, role } = socket.data || {};
    if (!code || !username || !text?.trim()) return cb?.({ ok: false });
    const msg = { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, username, role, text: text.trim(), ts: Date.now() };
    channels[code].messages.push(msg);
    io.to(code).emit('chat:message', msg);
    cb?.({ ok: true });
  });

  // ── ADMIN: announce ──
  socket.on('admin:announce', ({ text }, cb) => {
    const { code, role } = socket.data || {};
    if (role !== 'admin') return;
    const msg = { text: `📢 ${text}`, ts: Date.now(), isAnnouncement: true };
    channels[code].messages.push({ username: '__system__', ...msg });
    io.to(code).emit('chat:system', msg);
    cb?.({ ok: true });
  });

  // ── ADMIN: close channel ──
  socket.on('admin:close-channel', (_, cb) => {
    const { code, role } = socket.data || {};
    if (role !== 'admin') return;
    io.to(code).emit('channel:closed', { message: 'Admin has closed this channel.' });
    io.in(code).socketsLeave(code);
    delete channels[code];
    cb?.({ ok: true });
  });

  // ══════════════ VOICE / WebRTC SIGNALLING ══════════════

  // User requests to join voice room
  socket.on('voice:join', (_, cb) => {
    const { code, username } = socket.data || {};
    if (!code) return cb?.({ ok: false });
    const ch = channels[code];
    ch.voiceUsers.add(socket.id);

    // Tell existing voice users about new peer
    const peersInVoice = [...ch.voiceUsers].filter(id => id !== socket.id);
    peersInVoice.forEach(peerId => {
      io.to(peerId).emit('voice:new-peer', { fromId: socket.id, username });
    });

    broadcastVoiceUsers(code);
    cb?.({ ok: true, peers: peersInVoice });
    io.to(code).emit('chat:system', { text: `🎙️ ${username} joined voice`, ts: Date.now() });
  });

  socket.on('voice:leave', () => {
    leaveVoice(socket);
  });

  // WebRTC signalling relay
  socket.on('voice:offer', ({ targetId, offer }) => {
    io.to(targetId).emit('voice:offer', { fromId: socket.id, offer });
  });
  socket.on('voice:answer', ({ targetId, answer }) => {
    io.to(targetId).emit('voice:answer', { fromId: socket.id, answer });
  });
  socket.on('voice:ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('voice:ice', { fromId: socket.id, candidate });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const { code, username } = socket.data || {};
    if (code && channels[code]) {
      leaveVoice(socket, true);
      channels[code].members.delete(socket.id);
      broadcastMembers(code);
      if (username) {
        io.to(code).emit('chat:system', { text: `${username} left the channel`, ts: Date.now() });
      }
    }
    console.log(`[-] ${socket.id}`);
  });

  function leaveVoice(sock, silent = false) {
    const { code, username } = sock.data || {};
    if (!code || !channels[code]) return;
    const ch = channels[code];
    if (ch.voiceUsers.has(sock.id)) {
      ch.voiceUsers.delete(sock.id);
      io.to(code).emit('voice:peer-left', { fromId: sock.id });
      broadcastVoiceUsers(code);
      if (!silent && username) {
        io.to(code).emit('chat:system', { text: `🔇 ${username} left voice`, ts: Date.now() });
      }
    }
  }
});

function broadcastMembers(code) {
  if (!channels[code]) return;
  const list = [...channels[code].members.values()];
  io.to(code).emit('channel:members', { count: list.length, users: list });
}

function broadcastVoiceUsers(code) {
  if (!channels[code]) return;
  const voiceIds = [...channels[code].voiceUsers];
  const users = voiceIds.map(id => {
    const m = channels[code].members.get(id);
    return { id, username: m?.username || '?' };
  });
  io.to(code).emit('voice:users', users);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    SECRET CODE CHAT v2 — WITH VOICE      ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}            ║`);
  console.log(`║  Network: http://${ip}:${PORT}         ║`);
  console.log('║                                          ║');
  console.log('║  Share the Network URL with others       ║');
  console.log('╚══════════════════════════════════════════╝\n');
});
