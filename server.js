const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── FIREBASE ADMIN ──
let db = null;
let auth = null;

try {
  const admin = require('firebase-admin');
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    db = admin.firestore();
    auth = admin.auth();
    console.log('[Firebase] Connected ✓');
  } else {
    console.log('[Firebase] No credentials — running in memory mode');
  }
} catch (e) {
  console.log('[Firebase] Error:', e.message);
}

// ── IN-MEMORY FALLBACK (when no Firebase) ──
const memChannels = {};
const memUsers = {};
const memNotifications = {};

// ── VISITOR TRACKING ──
const visitors = [];

function parseUA(ua) {
  let browser = 'Unknown', os = 'Unknown', device = 'Desktop';
  if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
  else if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
  else if (ua.includes('Edg')) browser = 'Edge';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Mac')) os = 'macOS';
  else if (ua.includes('Linux')) os = 'Linux';
  if (ua.includes('Mobile') || ua.includes('Android') || ua.includes('iPhone')) device = 'Mobile';
  else if (ua.includes('iPad')) device = 'Tablet';
  return { browser, os, device };
}

function countryFlag(code) {
  if (!code || code.length !== 2) return '🌐';
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

// ── API ROUTES ──

// Track visit
app.post('/api/visit', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
    const ua = req.headers['user-agent'] || '';
    const page = req.body.page || '/';
    const { browser, os, device } = parseUA(ua);
    let country = 'Unknown', city = 'Unknown', flag = '🌐';
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,countryCode`);
      const geo = await geoRes.json();
      if (geo.status !== 'fail') { country = geo.country||'Unknown'; city = geo.city||'Unknown'; flag = countryFlag(geo.countryCode); }
    } catch(e) {}
    visitors.push({ ts: Date.now(), ip, browser, os, device, country, city, flag, page });
    if (visitors.length > 1000) visitors.shift();
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.get('/api/visitors', (req, res) => res.json({ visitors }));
app.post('/api/visitors/clear', (req, res) => { visitors.length = 0; res.json({ ok: true }); });

// Create channel (requires auth token)
app.post('/api/channels/create', async (req, res) => {
  const { token, name, code, description } = req.body;
  if (!token || !name || !code) return res.json({ ok: false, error: 'Missing fields' });

  try {
    let uid, email, displayName;

    if (auth) {
      const decoded = await auth.verifyIdToken(token);
      uid = decoded.uid;
      email = decoded.email;
      displayName = decoded.name || email.split('@')[0];
    } else {
      // memory mode
      uid = token;
      email = memUsers[uid]?.email || 'unknown';
      displayName = memUsers[uid]?.displayName || 'User';
    }

    // Check 3-channel limit
    let createdCount = 0;
    if (db) {
      const snap = await db.collection('channels').where('createdByUid', '==', uid).get();
      createdCount = snap.size;
    } else {
      createdCount = Object.values(memChannels).filter(c => c.createdByUid === uid).length;
    }

    if (createdCount >= 3) {
      return res.json({ ok: false, error: 'You can only create 3 channels per account.' });
    }

    // Check code uniqueness
    if (db) {
      const existing = await db.collection('channels').where('code', '==', code.toUpperCase()).get();
      if (!existing.empty) return res.json({ ok: false, error: 'Code already in use.' });
    } else {
      if (memChannels[code.toUpperCase()]) return res.json({ ok: false, error: 'Code already in use.' });
    }

    const channel = {
      name, code: code.toUpperCase(),
      description: description || '',
      createdByUid: uid,
      createdBy: displayName,
      createdAt: Date.now(),
      members: [uid],
      messageCount: 0
    };

    if (db) {
      await db.collection('channels').doc(code.toUpperCase()).set(channel);
    } else {
      memChannels[code.toUpperCase()] = { ...channel, messages: [] };
    }

    res.json({ ok: true, channel });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Get channel info
app.get('/api/channels/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    if (db) {
      const doc = await db.collection('channels').doc(code).get();
      if (!doc.exists) return res.json({ ok: false, error: 'Channel not found' });
      res.json({ ok: true, channel: doc.data() });
    } else {
      const ch = memChannels[code];
      if (!ch) return res.json({ ok: false, error: 'Channel not found' });
      res.json({ ok: true, channel: ch });
    }
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Get user profile
app.get('/api/profile/:uid', async (req, res) => {
  try {
    if (db) {
      const doc = await db.collection('users').doc(req.params.uid).get();
      res.json({ ok: true, profile: doc.exists ? doc.data() : null });
    } else {
      res.json({ ok: true, profile: memUsers[req.params.uid] || null });
    }
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Update user profile
app.post('/api/profile/update', async (req, res) => {
  const { token, displayName, bio, avatar } = req.body;
  try {
    let uid;
    if (auth) { const d = await auth.verifyIdToken(token); uid = d.uid; }
    else uid = token;

    const profile = { displayName, bio: bio||'', avatar: avatar||'', updatedAt: Date.now() };
    if (db) await db.collection('users').doc(uid).set(profile, { merge: true });
    else memUsers[uid] = { ...(memUsers[uid]||{}), ...profile };

    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Get notifications
app.get('/api/notifications/:uid', (req, res) => {
  const notes = memNotifications[req.params.uid] || [];
  res.json({ ok: true, notifications: notes.slice(-20).reverse() });
});

// ── REALTIME SOCKET ──
const activeChannels = {}; // code -> { members: Map, voiceUsers: Set, messages: [] }

function getOrCreateChannel(code) {
  if (!activeChannels[code]) {
    activeChannels[code] = { members: new Map(), voiceUsers: new Set(), messages: [] };
  }
  return activeChannels[code];
}

function addNotification(uid, note) {
  if (!memNotifications[uid]) memNotifications[uid] = [];
  memNotifications[uid].push({ ...note, ts: Date.now(), read: false });
  if (memNotifications[uid].length > 50) memNotifications[uid].shift();
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('user:join-channel', async ({ secretCode, username, uid, role: reqRole }, cb) => {
    const code = secretCode?.toUpperCase();
    if (!code || !username) return cb({ ok: false, error: 'Missing fields.' });

    // Check channel exists
    let channelData = null;
    if (db) {
      const doc = await db.collection('channels').doc(code).get();
      if (!doc.exists) return cb({ ok: false, error: 'Invalid secret code.' });
      channelData = doc.data();
    } else {
      channelData = memChannels[code];
      if (!channelData) return cb({ ok: false, error: 'Invalid secret code.' });
    }

    const role = channelData.createdByUid === uid ? 'admin' : (reqRole === 'admin' ? 'user' : 'user');

    socket.join(code);
    const ch = getOrCreateChannel(code);
    ch.members.set(socket.id, { username, role, uid });
    socket.data = { code, username, role, uid };

    // Add to channel members in DB
    if (db && uid) {
      await db.collection('channels').doc(code).update({
        members: require('firebase-admin').firestore.FieldValue.arrayUnion(uid)
      });
    }

    cb({ ok: true, channel: { name: channelData.name, createdBy: channelData.createdBy, description: channelData.description }, history: ch.messages.slice(-100) });
    broadcastMembers(code);
    socket.to(code).emit('chat:system', { text: `${username} joined`, ts: Date.now() });

    // Notify channel creator
    if (channelData.createdByUid && channelData.createdByUid !== uid) {
      addNotification(channelData.createdByUid, {
        type: 'join', text: `${username} joined your channel #${channelData.name}`, channel: code
      });
      // Emit to creator if online
      for (const [sid, m] of ch.members.entries()) {
        if (m.uid === channelData.createdByUid) {
          io.to(sid).emit('notification:new', { text: `${username} joined #${channelData.name}` });
        }
      }
    }
  });

  socket.on('chat:message', ({ text }, cb) => {
    const { code, username, role } = socket.data || {};
    if (!code || !username || !text?.trim()) return cb?.({ ok: false });
    const msg = { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, username, role, text: text.trim(), ts: Date.now(), type: 'text' };
    const ch = getOrCreateChannel(code);
    ch.messages.push(msg);
    if (ch.messages.length > 200) ch.messages.shift();
    io.to(code).emit('chat:message', msg);
    // Notify offline members
    ch.members.forEach((m, sid) => {
      if (m.uid && m.uid !== socket.data.uid) {
        io.to(sid).emit('notification:new', { text: `${username}: ${text.trim().slice(0,40)}`, channel: code });
      }
    });
    cb?.({ ok: true });
  });

  socket.on('chat:photo', ({ dataUrl }, cb) => {
    const { code, username, role } = socket.data || {};
    if (!code || !username || !dataUrl) return cb?.({ ok: false });
    const msg = { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, username, role, dataUrl, ts: Date.now(), type: 'photo' };
    const ch = getOrCreateChannel(code);
    ch.messages.push(msg);
    io.to(code).emit('chat:message', msg);
    cb?.({ ok: true });
  });

  socket.on('admin:announce', ({ text }, cb) => {
    const { code, role } = socket.data || {};
    if (role !== 'admin') return;
    const msg = { text: `📢 ${text}`, ts: Date.now(), isAnnouncement: true };
    getOrCreateChannel(code).messages.push({ username: '__system__', ...msg });
    io.to(code).emit('chat:system', msg);
    cb?.({ ok: true });
  });

  socket.on('admin:kick', ({ targetUsername }, cb) => {
    const { code, role } = socket.data || {};
    if (role !== 'admin') return cb?.({ ok: false });
    const ch = getOrCreateChannel(code);
    let targetSocketId = null;
    for (const [sid, m] of ch.members.entries()) {
      if (m.username === targetUsername && m.role !== 'admin') { targetSocketId = sid; break; }
    }
    if (!targetSocketId) return cb?.({ ok: false, error: 'User not found.' });
    io.to(targetSocketId).emit('user:kicked', { message: 'You were removed by the admin.' });
    const ts = io.sockets.sockets.get(targetSocketId);
    if (ts) { ts.leave(code); ts.data = {}; }
    ch.members.delete(targetSocketId);
    ch.voiceUsers.delete(targetSocketId);
    broadcastMembers(code);
    io.to(code).emit('voice:peer-left', { fromId: targetSocketId });
    io.to(code).emit('chat:system', { text: `👢 ${targetUsername} was removed`, ts: Date.now() });
    cb?.({ ok: true });
  });

  socket.on('admin:close-channel', (_, cb) => {
    const { code, role } = socket.data || {};
    if (role !== 'admin') return;
    io.to(code).emit('channel:closed', { message: 'Admin closed this channel.' });
    io.in(code).socketsLeave(code);
    delete activeChannels[code];
    cb?.({ ok: true });
  });

  // Voice/Video WebRTC
  socket.on('voice:join', ({ video = false } = {}, cb) => {
    const { code, username } = socket.data || {};
    if (!code) return cb?.({ ok: false });
    const ch = getOrCreateChannel(code);
    ch.voiceUsers.add(socket.id);
    const peers = [...ch.voiceUsers].filter(id => id !== socket.id);
    peers.forEach(p => io.to(p).emit('voice:new-peer', { fromId: socket.id, username, video }));
    broadcastVoiceUsers(code);
    cb?.({ ok: true, peers });
    io.to(code).emit('chat:system', { text: `${video?'📹':'🎙️'} ${username} joined ${video?'video':'voice'}`, ts: Date.now() });
  });

  socket.on('voice:leave', () => leaveVoice(socket));
  socket.on('voice:offer', ({ targetId, offer }) => io.to(targetId).emit('voice:offer', { fromId: socket.id, offer }));
  socket.on('voice:answer', ({ targetId, answer }) => io.to(targetId).emit('voice:answer', { fromId: socket.id, answer }));
  socket.on('voice:ice', ({ targetId, candidate }) => io.to(targetId).emit('voice:ice', { fromId: socket.id, candidate }));

  socket.on('disconnect', () => {
    const { code, username } = socket.data || {};
    if (code && activeChannels[code]) {
      leaveVoice(socket, true);
      activeChannels[code].members.delete(socket.id);
      broadcastMembers(code);
      if (username) io.to(code).emit('chat:system', { text: `${username} left`, ts: Date.now() });
    }
  });

  function leaveVoice(sock, silent = false) {
    const { code, username } = sock.data || {};
    if (!code || !activeChannels[code]) return;
    const ch = activeChannels[code];
    if (ch.voiceUsers.has(sock.id)) {
      ch.voiceUsers.delete(sock.id);
      io.to(code).emit('voice:peer-left', { fromId: sock.id });
      broadcastVoiceUsers(code);
      if (!silent && username) io.to(code).emit('chat:system', { text: `🔇 ${username} left voice`, ts: Date.now() });
    }
  }
});

function broadcastMembers(code) {
  const ch = activeChannels[code]; if (!ch) return;
  const list = [...ch.members.entries()].map(([id, m]) => ({ ...m, socketId: id }));
  io.to(code).emit('channel:members', { count: list.length, users: list });
}
function broadcastVoiceUsers(code) {
  const ch = activeChannels[code]; if (!ch) return;
  const users = [...ch.voiceUsers].map(id => { const m = ch.members.get(id); return { id, username: m?.username||'?' }; });
  io.to(code).emit('voice:users', users);
}

function getLocalIP() {
  const i = os.networkInterfaces();
  for (const n of Object.keys(i)) for (const iface of i[n]) if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  FRAME CHAT — AUTH + PROFILES + NOTIF  ║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  Local:   http://localhost:${PORT}          ║`);
  console.log(`║  Network: http://${ip}:${PORT}       ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);
});
