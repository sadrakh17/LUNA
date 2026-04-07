# Deploying Luna to Railway

## What you need
- A [Railway](https://railway.app) account (free to sign up)
- A [GitHub](https://github.com) account
- Your `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`

---

## Step 1 — Push code to GitHub

```bash
# In the telegram-claude-bot folder:
git init
git add .
git commit -m "Initial Luna bot"

# Create a new repo on github.com (call it luna-bot or anything)
# Then connect and push:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

---

## Step 2 — Create a Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo**
3. Select your repo → Railway will detect `package.json` automatically
4. Click **Deploy** — it will fail for now (no env vars yet), that's fine

---

## Step 3 — Add Redis

1. Inside your Railway project, click **+ New Service**
2. Choose **Database** → **Add Redis**
3. Railway creates a Redis instance and automatically injects `REDIS_URL`
   into your bot service — you don't need to copy anything manually

---

## Step 4 — Add environment variables

1. Click your **bot service** (not the Redis one)
2. Go to **Variables** tab
3. Add these one by one:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | your token from @BotFather |
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com |
| `BOT_NAME` | `Luna` |
| `BOT_USERNAME` | `@your_bot_username` |
| `BOT_SYSTEM_PROMPT` | *(copy the full prompt from .env.example)* |
| `REPLY_PROBABILITY` | `0.6` |
| `CONTEXT_MESSAGE_LIMIT` | `30` |
| `TYPING_DELAY` | `2000` |
| `INITIATE_CRON` | `0 9,11,13,15,17,19,21 * * *` |
| `INITIATE_PROBABILITY` | `0.7` |
| `INITIATE_DELAY_MIN` | `3000` |
| `INITIATE_DELAY_MAX` | `15000` |

> `REDIS_URL` is already set automatically by Railway — do NOT add it manually.

4. Click **Deploy** after saving variables

---

## Step 5 — Verify it's running

1. Go to your bot service → **Deployments** tab
2. Click the active deployment → **View Logs**
3. You should see:
   ```
   [Redis] Connected ✓
   ✅ Luna (@your_bot) is online
   [Scheduler] Cron: "0 9,11,13,15,17,19,21 * * *", probability: 0.7
   ```
4. Add Luna to a Telegram group and test it

---

## Updating Luna

Any time you push changes to GitHub:

```bash
git add .
git commit -m "update"
git push
```

Railway auto-redeploys within ~30 seconds. Memory is safe in Redis — nothing is lost during redeploys.

---

## Costs

| Service | Cost |
|---|---|
| Railway Hobby plan | ~$5/month |
| Redis (Railway addon) | ~$0–2/month depending on usage |
| Anthropic API | Pay per use (~$0.003/message with Sonnet) |

For a small active group (~100 messages/day), total cost is roughly **$7–10/month**.

---

## Troubleshooting

**Bot not responding in group:**
- Make sure you did `/setprivacy` → Disabled in @BotFather
- Check Railway logs for errors

**Redis connection error:**
- Confirm the Redis service is running in Railway dashboard
- `REDIS_URL` should be auto-injected; check Variables tab to confirm it's there

**Memory not persisting:**
- Check logs for `[Redis] Connected ✓` — if missing, Redis isn't connecting
- Never set `REDIS_URL=redis://localhost:6379` in Railway (that's for local dev only)
