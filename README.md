# 🔐 Secret Code Chat v2 — with Voice

Real-time private chat with **text + voice**, protected by secret codes.

---

## 🖥️ Setup in VS Code (Step by Step)

### Step 1 — Install Node.js
1. Go to https://nodejs.org
2. Download the **LTS** version (green button)
3. Run the installer — click Next through all steps
4. Restart your computer after install

### Step 2 — Open project in VS Code
1. Download and unzip `secret-chat-v2.zip`
2. Open VS Code
3. Click **File → Open Folder**
4. Select the `secret-chat-v2` folder
5. Click **Select Folder**

### Step 3 — Open the terminal in VS Code
- Press `Ctrl + backtick` (the key above Tab)
- Or go to **Terminal → New Terminal**

### Step 4 — Install dependencies
Type this and press Enter:
```
npm install
```
Wait for it to finish (you'll see a "added X packages" message)

### Step 5 — Start the server
```
npm start
```
You'll see:
```
╔══════════════════════════════════════════╗
║    SECRET CODE CHAT v2 — WITH VOICE      ║
╠══════════════════════════════════════════╣
║  Local:   http://localhost:3000            ║
║  Network: http://192.168.x.x:3000         ║
╚══════════════════════════════════════════╝
```

### Step 6 — Open the app
- **You (on same computer):** open http://localhost:3000
- **Others on same WiFi:** open the Network URL shown in your terminal

---

## 📱 How to use

**Admin:**
1. Click "Admin" → enter your name, channel name, secret code
2. Click "Create Channel"
3. Share the **secret code** and **Network URL** with your users

**Users:**
1. Open the Network URL in their browser
2. Click "User" → enter their name and the secret code
3. They're in!

**Voice chat:**
- Click **"Join Voice"** — browser will ask for microphone permission
- Allow it → you'll appear in the voice panel
- Others who join voice can hear you live
- Click **"Mute"** to silence yourself
- Click **"Leave Voice"** to exit voice only

---

## 🌐 Put it on Google / Internet (so anyone can use it)

### Option A — Railway.app (FREE, easiest)

1. Create a free account at https://railway.app
2. Go to https://github.com and create a free account
3. Create a new repository called `secret-chat`
4. In VS Code terminal, run:
   ```
   git init
   git add .
   git commit -m "first commit"
   git remote add origin https://github.com/YOUR_USERNAME/secret-chat.git
   git push -u origin main
   ```
5. Go to Railway → New Project → Deploy from GitHub repo
6. Select your `secret-chat` repo
7. Railway auto-detects Node.js and deploys
8. Click **"Generate Domain"** → you get a free URL like `secret-chat.up.railway.app`
9. Share that URL with anyone in the world!

### Option B — Render.com (FREE)

1. Create account at https://render.com
2. New → Web Service → Connect GitHub repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Free URL like `secret-chat.onrender.com`

### Option C — ngrok (for testing, no server needed)

1. Download ngrok from https://ngrok.com/download
2. While your server is running (`npm start`), open a NEW terminal
3. Run: `ngrok http 3000`
4. Share the `https://xxxx.ngrok-free.app` URL

---

## 📁 Files
```
secret-chat-v2/
├── server.js       ← Node.js backend (Socket.IO + WebRTC signalling)
├── package.json    ← Dependencies
└── public/
    └── index.html  ← Full frontend (text + voice chat)
```

## ⚠️ Voice chat notes
- Voice requires HTTPS in production (Railway/Render provide this automatically)
- On local WiFi, it works on http:// too for most browsers
- Each user needs to click "Allow" when browser asks for microphone

