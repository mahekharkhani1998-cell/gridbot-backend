# GridBot Backend — Deployment Guide

## Stack
- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: PostgreSQL
- **Language**: JavaScript (same as React frontend — one codebase)
- **Hosting**: DigitalOcean (recommended) or Railway.app

---

## Step 1 — Create DigitalOcean account
1. Go to https://digitalocean.com → Sign up
2. Create a **Droplet** (server):
   - Region: **Bangalore** (closest to NSE/BSE)
   - Image: **Ubuntu 24.04**
   - Size: **Basic $6/month** (1 vCPU, 1GB RAM — enough for 10-20 bots)
   - Add your SSH key or use password login

---

## Step 2 — Create PostgreSQL database
In DigitalOcean dashboard:
1. Left menu → **Databases** → Create → PostgreSQL 16
2. Region: Bangalore
3. Plan: Basic $15/month (or use free tier on Railway)
4. Copy the **connection string** → looks like:
   `postgresql://doadmin:password@host:25060/defaultdb?sslmode=require`

---

## Step 3 — Connect to your server
```bash
ssh root@YOUR_SERVER_IP
```

---

## Step 4 — Install Node.js on server
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should show v20.x
```

---

## Step 5 — Upload this backend code
Option A — GitHub (recommended):
```bash
# On your laptop: push to GitHub
git init
git add .
git commit -m "GridBot backend v1"
git remote add origin https://github.com/YOUR_USERNAME/gridbot-backend
git push -u origin main

# On server:
git clone https://github.com/YOUR_USERNAME/gridbot-backend
cd gridbot-backend
npm install
```

Option B — Direct copy using SCP:
```bash
scp -r gridbot-backend/ root@YOUR_SERVER_IP:/root/
```

---

## Step 6 — Configure environment variables
```bash
cd /root/gridbot-backend
cp .env.example .env
nano .env
```

Fill in:
```
DATABASE_URL=postgresql://doadmin:PASSWORD@HOST:25060/defaultdb?sslmode=require
JWT_SECRET=generate_64_random_chars_here
ENCRYPTION_KEY=exactly_32_characters_here__
FRONTEND_URL=https://your-frontend.vercel.app
PORT=4000
```

Generate secure secrets:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"  # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"  # ENCRYPTION_KEY (32 hex chars)
```

---

## Step 7 — Run with PM2 (keeps running 24/7)
```bash
npm install -g pm2

# Start the server
pm2 start src/index.js --name gridbot

# Auto-restart on server reboot
pm2 startup
pm2 save

# View logs
pm2 logs gridbot

# Monitor
pm2 monit
```

---

## Step 8 — Open firewall port
```bash
sudo ufw allow 4000
sudo ufw allow 22
sudo ufw enable
```

---

## Step 9 — Test it
```bash
curl http://YOUR_SERVER_IP:4000/health
# Should return: {"status":"ok","time_ist":"...","version":"1.0.0"}
```

---

## Step 10 — (Optional) Add domain + HTTPS
Using Nginx as reverse proxy:
```bash
sudo apt install nginx certbot python3-certbot-nginx -y

# Create nginx config
sudo nano /etc/nginx/sites-available/gridbot
```
Paste:
```nginx
server {
    server_name api.yourdomain.com;
    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/gridbot /etc/nginx/sites-enabled/
sudo certbot --nginx -d api.yourdomain.com
sudo systemctl reload nginx
```

---

## Connect Frontend to Backend
In your React app, set the API base URL:
```js
// src/config.js
export const API_URL = "https://api.yourdomain.com";  // or http://IP:4000 for testing

// Example: login
const res = await fetch(`${API_URL}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
```

---

## API Endpoints Summary

| Method | URL | Description |
|--------|-----|-------------|
| POST | /api/auth/register | Create admin account |
| POST | /api/auth/login | Login → get JWT token |
| GET  | /api/clients | List all clients |
| POST | /api/clients | Add client with credentials |
| PUT  | /api/clients/:id | Edit client |
| GET  | /api/clients/:id/holdings | Fetch holdings from broker |
| GET  | /api/clients/:id/positions | Fetch positions from broker |
| GET  | /api/clients/:id/limits | Fetch fund limits |
| GET  | /api/bots | List all bots |
| POST | /api/bots | Create bot |
| POST | /api/bots/:id/start | Start bot |
| POST | /api/bots/:id/stop | Stop bot (hold shares) |
| POST | /api/bots/:id/kill | Kill bot (square off) |
| POST | /api/bots/kill-all | ⚡ Kill all bots |
| GET  | /api/orders | Order history |
| GET  | /api/market/scripts?exchange=NSE_EQ&q=BSE | Search scripts |
| GET  | /api/market/expiries?exchange=NSE_FNO | Get expiry dates |
| POST | /api/market/refresh | Refresh NSE/BSE script master |
| WS   | /ws | WebSocket for live prices + bot events |

---

## Monthly Cost Estimate
| Item | Cost |
|------|------|
| DigitalOcean Droplet (Bangalore) | $6/month |
| DigitalOcean PostgreSQL | $15/month |
| Domain (optional, GoDaddy/Namecheap) | ~$1/month |
| **Total** | **~$22/month (~₹1,850/month)** |

Railway.app alternative: ~$5/month total (DB included in hobby plan).

---

## IST Notes
- All logs use IST (Asia/Kolkata, UTC+5:30)
- Token refresh: 8:00 AM IST daily (weekdays)
- Script master refresh: 6:00 AM IST daily (weekdays)
- EOD grid cancel: 15:20 IST
- Market hours: 9:15 AM – 3:30 PM IST
- DB stores timestamps as UTC, all API responses include `_ist` fields
