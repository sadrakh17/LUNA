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
        const reply = await generateReply(chatId, `${BOT_NAME} baru masuk ke grup ini.`, {
          userId: 0, username: 'System', firstName: 'System',
        });
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
    try {
      await bot.sendChatAction(chatId, 'typing');
      const analysis = await analyzeGroup(chatId);
      await bot.sendMessage(chatId, `📊 *Group Analysis*\n\n${analysis}`, { parse_mode: 'Markdown' });
    } catch (err) { console.error('[/analyze]', err.message); }
    return;
  }

  if (text.startsWith('/stats')) {
    try {
      const s = await memory.stats(chatId);
      await bot.sendMessage(chatId,
        `👥 Users known: ${s.userCount}\n💬 Messages in memory: ${s.messageCount}\n🧠 Knowledge entries: ${s.knowledgeCount}\n🗣 Participants: ${s.participants.join(', ') || 'none'}`
      );
    } catch (err) { console.error('[/stats]', err.message); }
    return;
  }

  if (text.startsWith('/reset')) {
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

  if (!mustReply && Math.random() > REPLY_PROB) {
    // Silently store message to maintain context
    await memory.addMessage(chatId, 'user', text, senderMeta);
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    await sleep(TYPING_DELAY + Math.random() * 1500);

    const reply = await generateReply(chatId, text, senderMeta);

    if (reply) {
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
