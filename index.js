// src/index.js
// Main entry point — async-aware for Redis-backed memory

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { generateReply, analyzeGroup } from './claude.js';
import { memory } from './memory.js';
import { trackGroup, untrackGroup, startScheduler } from './scheduler.js';

const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const BOT_NAME     = process.env.BOT_NAME || 'Luna';
const REPLY_PROB   = parseFloat(process.env.REPLY_PROBABILITY || '0.6');
const TYPING_DELAY = parseInt(process.env.TYPING_DELAY || '2000');

// ─── Active hours (WIB = UTC+7) ───────────────────────────────────────────
// Active: 9am–3pm and 5pm–midnight
// Inactive: 3pm–5pm (afternoon break) and midnight–9am (sleeping)

function getWIBHour() {
  return (new Date().getUTCHours() + 7) % 24;
}

function isActiveHour() {
  const h = getWIBHour();
  return (h >= 9 && h < 15) || (h >= 17 && h < 24);
}

// Human-like reply delay: 10–25s active, 30–90s inactive
function getReplyDelay() {
  if (isActiveHour()) {
    return 10000 + Math.random() * 15000;
  }
  return 30000 + Math.random() * 60000;
}

// Offline during: 3pm–5pm (5% chance) and midnight–9am (5% chance)
function shouldBeOnline() {
  const h = getWIBHour();
  if ((h >= 15 && h < 17) || (h >= 0 && h < 9)) {
    return Math.random() < 0.05;
  }
  return true;
}

if (!TOKEN)                          throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!process.env.ANTHROPIC_API_KEY)  throw new Error('ANTHROPIC_API_KEY is required');
if (!process.env.REDIS_URL)          console.warn('[Warn] REDIS_URL not set — using localhost:6379');

const bot = new TelegramBot(TOKEN, { polling: true });
let BOT_USERNAME = null;

bot.getMe().then(me => {
  BOT_USERNAME = me.username;
  console.log(`\n✅ ${BOT_NAME} (@${BOT_USERNAME}) is online\n`);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractSenderMeta(from) {
  return {
    userId:    from?.id    || 0,
    username:  from?.username  || null,
    firstName: from?.first_name || null,
  };
}

// ─── Group join / leave ───────────────────────────────────────────────────
bot.on('my_chat_member', async (update) => {
  const chatId = update.chat.id;
  const status = update.new_chat_member?.status;

  if (status === 'member' || status === 'administrator') {
    trackGroup(chatId);
    setTimeout(async () => {
      try {
        await bot.sendChatAction(chatId, 'typing');
        await sleep(2500);
        let reply = await generateReply(chatId, `${BOT_NAME} baru masuk ke grup ini.`, {
          userId: 0, username: 'System', firstName: 'System',
        });
        reply = reply.replace(/\n{2,}/g, ' ').trim();
        await bot.sendMessage(chatId, reply);
      } catch (err) {
        console.error('[Join greeting]', err.message);
      }
    }, 3000);

  } else if (['kicked', 'left'].includes(status)) {
    untrackGroup(chatId);
    await memory.clear(chatId);
  }
});

// ─── Message handler ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId   = msg.chat.id;
  const chatType = msg.chat.type;
  const text     = msg.text?.trim();

  if (!text) return;

  const senderMeta = extractSenderMeta(msg.from);
  if (chatType !== 'private') trackGroup(chatId);

  // Always ensure user profile exists in Redis
  await memory.getUser(senderMeta.userId, senderMeta.username, senderMeta.firstName);

  // ─── Admin commands ────────────────────────────────────────────────────

  if (text.startsWith('/analyze')) {
  if (senderMeta.username !== 'parzival_517') return;
    try {
      await bot.sendChatAction(chatId, 'typing');
      const analysis = await analyzeGroup(chatId);
      await bot.sendMessage(chatId, `📊 *Group Analysis*\n\n${analysis}`, { parse_mode: 'Markdown' });
    } catch (err) { console.error('[/analyze]', err.message); }
    return;
  }

  if (text.startsWith('/stats')) {
  if (senderMeta.username !== 'parzival_517') return;
    try {
      const s = await memory.stats(chatId);
      await bot.sendMessage(chatId,
        `👥 Users known: ${s.userCount}\n💬 Messages in memory: ${s.messageCount}\n🧠 Knowledge entries: ${s.knowledgeCount}\n🗣 Participants: ${s.participants.join(', ') || 'none'}`
      );
    } catch (err) { console.error('[/stats]', err.message); }
    return;
  }

  if (text.startsWith('/reset')) {
  if (senderMeta.username !== 'parzival_517') {
    await bot.sendMessage(chatId, 'kamu siapa tiba-tiba mau reset 😒');
    return;
  }
  await memory.clear(chatId);
  await bot.sendMessage(chatId, '🧹 Chat memory cleared.');
  return;
}

  // ─── Reply logic ───────────────────────────────────────────────────────

  const nameLower = BOT_NAME.toLowerCase();
  const msgLower  = text.toLowerCase();

  const isMentioned  = msgLower.includes(`@${BOT_USERNAME?.toLowerCase()}`) || msgLower.includes(nameLower);
  const isDM         = chatType === 'private';
  const isReplyToBot = msg.reply_to_message?.from?.username === BOT_USERNAME;
  const mustReply    = isMentioned || isDM || isReplyToBot;

  // Always store message for context, even if not replying
  if (!mustReply) {
    await memory.addMessage(chatId, 'user', text, senderMeta);

    // Check if she's "online" right now
    if (!shouldBeOnline()) return;

    // Random chance to reply
    if (Math.random() > REPLY_PROB) return;

    // Don't reply to very short messages unless directly mentioned
    // (avoids replying to "wkwk", "haha", "oh", "iya" etc)
    const wordCount = text.trim().split(/\s+/).length;
    if (wordCount <= 2 && !isMentioned) return;

    // Don't reply if message seems directed at someone else
    // (contains @username that isn't Luna)
    const mentionsOther = text.includes('@') && !isMentioned;
    if (mentionsOther) return;
  }

  try {
    // Human-like delay before even starting to "type"
    const replyDelay = mustReply
      ? 5000 + Math.random() * 8000   // 5–13s if directly addressed
      : getReplyDelay();               // 10–25s or 30–90s based on time

    await sleep(replyDelay);
    await bot.sendChatAction(chatId, 'typing');

    // Simulate reading + typing time
    const typingTime = 2000 + Math.random() * 3000;
    await sleep(typingTime);

    let reply = await generateReply(chatId, text, senderMeta);

    if (reply) {
      reply = reply.replace(/\n{2,}/g, ' ').trim();
      const options = chatType !== 'private' ? { reply_to_message_id: msg.message_id } : {};
      await bot.sendMessage(chatId, reply, options);
    }
  } catch (err) {
    console.error('[Message handler]', err.message);
  }
});

// ─── Errors & scheduler ───────────────────────────────────────────────────
bot.on('polling_error', err => console.error('[Polling error]', err.message));
startScheduler(bot);
