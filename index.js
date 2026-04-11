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

// ─── Per-chat message buffer ──────────────────────────────────────────────
// Each chat has a buffer that accumulates incoming messages.
// A 15s timer resets every time a new message arrives.
// When the timer fires, Luna reads ALL buffered messages together,
// decides if/how to respond, and sends 1–3 messages depending on context.

const chatBuffers  = new Map(); // chatId -> { messages: [], timer, hasMustReply }
const BUFFER_WAIT  = 15000;    // 15 seconds — resets on every new message

const financeKeywords = [
  'btc','bitcoin','eth','crypto','saham','forex','trading','xau','gold','emas',
  'pump','dump','bullish','bearish','breakout','support','resistance','chart',
  'timeframe','tf','entry','sl','tp','profit','rugi','loss','pair','market',
  'iran','us','war','perang','geopolitik','fed','inflasi','dolar','dollar',
  'nasdaq','sp500','oil','minyak','komoditas','altcoin','defi','macro',
  'sanksi','nuklir','opec','rate','suku bunga'
];

function isFinanceMsg(text) {
  const t = text.toLowerCase();
  return financeKeywords.some(kw => t.includes(kw));
}

// ─── Admin commands ───────────────────────────────────────────────────────
async function handleAdminCommand(msg, chatId, text, senderMeta) {
  if (text.startsWith('/analyze')) {
    if (senderMeta.username !== 'parzival_517') return true;
    try {
      await bot.sendChatAction(chatId, 'typing');
      const analysis = await analyzeGroup(chatId);
      await bot.sendMessage(chatId, `📊 *Group Analysis*\n\n${analysis}`, { parse_mode: 'Markdown' });
    } catch (err) { console.error('[/analyze]', err.message); }
    return true;
  }
  if (text.startsWith('/stats')) {
    if (senderMeta.username !== 'parzival_517') return true;
    try {
      const s = await memory.stats(chatId);
      await bot.sendMessage(chatId,
        `👥 Users known: ${s.userCount}\n💬 Messages in memory: ${s.messageCount}\n🧠 Knowledge entries: ${s.knowledgeCount}\n🗣 Participants: ${s.participants.join(', ') || 'none'}`
      );
    } catch (err) { console.error('[/stats]', err.message); }
    return true;
  }
  if (text.startsWith('/reset')) {
    if (senderMeta.username !== 'parzival_517') {
      await bot.sendMessage(chatId, 'kamu siapa tiba-tiba mau reset 😒');
      return true;
    }
    await memory.clear(chatId);
    await bot.sendMessage(chatId, '🧹 Chat memory cleared.');
    return true;
  }
  return false;
}

// ─── Process buffered messages and decide whether/how to respond ──────────
async function processBuffer(chatId, chatType) {
  const buf = chatBuffers.get(chatId);
  if (!buf || buf.messages.length === 0) return;

  const messages = [...buf.messages];
  chatBuffers.delete(chatId);

  // Store all buffered messages into memory first
  for (const m of messages) {
    await memory.addMessage(chatId, 'user', m.text, m.senderMeta);
    await memory.getUser(m.senderMeta.userId, m.senderMeta.username, m.senderMeta.firstName);
  }

  // Check online status
  if (!shouldBeOnline()) return;

  const nameLower = BOT_NAME.toLowerCase();
  const botHandle = `@${BOT_USERNAME?.toLowerCase()}`;

  // Classify each message
  let hasMustReply   = false;
  let hasFinance     = false;
  let hasOtherMention = false;
  let totalWords     = 0;

  for (const m of messages) {
    const t = m.text.toLowerCase();
    const mentionsLuna = t.includes(botHandle) || t.includes(nameLower);
    const isReplyToBot = m.replyToBot;
    const isDM         = chatType === 'private';

    if (mentionsLuna || isReplyToBot || isDM) hasMustReply = true;
    if (isFinanceMsg(m.text)) hasFinance = true;
    if (m.text.includes('@') && !mentionsLuna) hasOtherMention = true;
    totalWords += m.text.trim().split(/\s+/).length;
  }

  // Decide whether to respond at all
  if (!hasMustReply) {
    // Ignore if all messages are directed at others
    if (hasOtherMention && !hasFinance) return;

    // Ignore if all messages are too short (pure reactions)
    if (totalWords <= messages.length * 2) return;

    // Finance topic: 80% chance. Otherwise normal probability
    const effectiveProb = hasFinance ? 0.8 : REPLY_PROB;
    if (Math.random() > effectiveProb) return;
  }

  // Build a combined context string of all buffered messages
  const contextSummary = messages
    .map(m => `[${m.senderMeta.username || m.senderMeta.firstName || 'someone'}]: ${m.text}`)
    .join('\n');

  // Typing simulation
  const typingDelay = hasMustReply
    ? 3000 + Math.random() * 4000
    : 4000 + Math.random() * 6000;

  await sleep(typingDelay);

  // Generate reply using the last message as the "trigger"
  // but Claude will see all of them in the context window
  const lastMsg = messages[messages.length - 1];

  try {
    await bot.sendChatAction(chatId, 'typing');
    await sleep(2000 + Math.random() * 2000);

    const { generateContextualReply } = await import('./claude.js');
    let reply = await generateContextualReply(chatId, contextSummary, lastMsg.senderMeta, messages.length, hasMustReply);

    if (!reply) return;

    // Split into natural message chunks if Claude returned multiple paragraphs
    // Max 3 messages. Each separated by a single newline with natural delay between.
    const chunks = reply
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    // Group into at most 3 sends
    const sends = [];
    if (chunks.length <= 3) {
      sends.push(...chunks);
    } else {
      // Merge excess chunks into the last send
      sends.push(chunks[0]);
      sends.push(chunks[1]);
      sends.push(chunks.slice(2).join(' '));
    }

    const replyToId = lastMsg.messageId;
    for (let i = 0; i < sends.length; i++) {
      const text = sends[i].replace(/\n{2,}/g, ' ').trim();
      if (!text) continue;
      const options = chatType !== 'private' && i === 0 ? { reply_to_message_id: replyToId } : {};
      await bot.sendMessage(chatId, text, options);
      if (i < sends.length - 1) {
        // Natural pause between messages (1.5–3s)
        await sleep(1500 + Math.random() * 1500);
        await bot.sendChatAction(chatId, 'typing');
        await sleep(1000 + Math.random() * 1500);
      }
    }
  } catch (err) {
    console.error('[ProcessBuffer]', err.message);
  }
}

// ─── Message handler ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId   = msg.chat.id;
  const chatType = msg.chat.type;
  const text     = msg.text?.trim();

  if (!text) return;

  const senderMeta = extractSenderMeta(msg.from);
  if (chatType !== 'private') trackGroup(chatId);

  // Handle admin commands immediately — no buffering
  const isCommand = await handleAdminCommand(msg, chatId, text, senderMeta);
  if (isCommand) return;

  // Buffer the message
  if (!chatBuffers.has(chatId)) {
    chatBuffers.set(chatId, { messages: [], timer: null });
  }

  const buf = chatBuffers.get(chatId);

  // Clear existing timer — reset the 15s window
  if (buf.timer) clearTimeout(buf.timer);

  buf.messages.push({
    text,
    senderMeta,
    messageId:  msg.message_id,
    replyToBot: msg.reply_to_message?.from?.username === BOT_USERNAME,
  });

  // Set new 15s timer
  buf.timer = setTimeout(() => processBuffer(chatId, chatType), BUFFER_WAIT);
});

// ─── Errors & scheduler ───────────────────────────────────────────────────
bot.on('polling_error', err => console.error('[Polling error]', err.message));
startScheduler(bot);
