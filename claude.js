// src/claude.js
// All Claude API calls — fully async-aware for Redis-backed memory

import Anthropic from '@anthropic-ai/sdk';
import { memory } from './memory.js';

const client        = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BASE_SYSTEM   = process.env.BOT_SYSTEM_PROMPT;
const CONTEXT_LIMIT = parseInt(process.env.CONTEXT_MESSAGE_LIMIT || '30');
const BOT_NAME      = process.env.BOT_NAME || 'Luna';

// ─── Reply to a message ───────────────────────────────────────────────────
export async function generateReply(chatId, incomingText, senderMeta) {
  const { userId, username, firstName } = senderMeta;

  // Ensure user profile exists / is updated in Redis
  const profile = await memory.getUser(userId, username, firstName);

  // Store incoming message
  await memory.addMessage(chatId, 'user', incomingText, { userId, username, firstName });

  // Build context: group history + user relationship info + knowledge
  const { addendum, messages } = await memory.buildContext(chatId, userId, CONTEXT_LIMIT);

  const displayName = profile.nickname || profile.firstName || profile.username || 'kamu';

  const system = BASE_SYSTEM
    + addendum
    + `\n\nPENTING SEKARANG: Kamu sedang membalas pesan dari ${displayName}. `
    + `Sesuaikan tone dan keterbukaan kamu dengan hubungan kalian. `
    + `Jawab singkat dan natural — 1–3 kalimat. Jangan pakai list atau markdown.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system,
    messages,
  });

  const reply = response.content[0]?.text?.trim() || '';

  // Store Luna's reply
  await memory.addMessage(chatId, 'assistant', reply);

  // Reward trust for the interaction
  await memory.rewardTrust(userId, 1);

  // Non-blocking background reflection
  setImmediate(() => reflect(userId, username || firstName, incomingText, reply));

  return reply;
}

// ─── Initiate a conversation unprompted ──────────────────────────────────
export async function generateInitiation(chatId) {
  const recent       = await memory.getRecentRaw(chatId, 15);
  const knowledgeCtx = await memory.getKnowledgeContext();

  let userPrompt;

  if (recent.length === 0) {
    userPrompt = `Kamu baru masuk ke grup ini. Kirim pesan pembuka yang natural dan casual. Jangan terlalu formal. 1–2 kalimat aja.`;
  } else {
    const summary = recent
      .map(m => `${m.username || m.firstName || BOT_NAME}: ${m.content}`)
      .join('\n');
    userPrompt = `Ini yang terjadi di grup belakangan ini:\n\n${summary}\n\nSekarang kamu mau masuk ke percakapan secara natural — bisa komentar, tanya sesuatu, atau bawa topik baru yang relevan. 1–2 kalimat, santai.`;
  }

  const system = BASE_SYSTEM + knowledgeCtx
    + `\n\nKamu lagi mau kirim pesan duluan tanpa diajak bicara. Jangan mulai dengan "hai semua" atau pembukaan kaku. Langsung aja natural.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const message = response.content[0]?.text?.trim() || '';
  await memory.addMessage(chatId, 'assistant', message);
  return message;
}

// ─── Analyze group conversation ───────────────────────────────────────────
export async function analyzeGroup(chatId) {
  const recent = await memory.getRecentRaw(chatId, 30);
  if (recent.length === 0) return 'Belum ada cukup percakapan untuk dianalisis.';

  const summary = recent
    .map(m => `${m.username || m.firstName || BOT_NAME}: ${m.content}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    system: 'You are an insightful analyst. Be concise and structured.',
    messages: [{
      role: 'user',
      content: `Analyze this group chat:\n\n${summary}\n\nCover: main topics, mood/tone, group dynamics, what people seem most interested in, notable patterns.`,
    }],
  });

  return response.content[0]?.text?.trim() || '';
}

// ─── Background reflection — extract and persist facts ───────────────────
async function reflect(userId, speakerName, userMessage, lunaReply) {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: `You extract structured data from conversations. Respond ONLY with valid JSON. No markdown, no explanation.`,
      messages: [{
        role: 'user',
        content: `Extract from this exchange:
1. Facts about the speaker (${speakerName})
2. Finance/general knowledge discussed
3. Luna's updated impression of the speaker (1 sentence, Indonesian, from Luna's POV)

Speaker: "${userMessage}"
Luna: "${lunaReply}"

JSON format:
{
  "userFacts": ["fact1"],
  "knowledgeFacts": [{"topic": "crypto", "content": "insight here"}],
  "lunaImpression": "Dia kayaknya..."
}

Return empty arrays if nothing relevant. Do not invent facts.`,
      }],
    });

    const raw  = response.content[0]?.text?.trim() || '{}';
    const data = JSON.parse(raw);

    if (data.userFacts?.length) {
      for (const fact of data.userFacts) await memory.addUserFact(userId, fact);
    }

    if (data.knowledgeFacts?.length) {
      for (const kf of data.knowledgeFacts) {
        if (kf.topic && kf.content) await memory.learnFact(kf.topic, kf.content, speakerName);
      }
    }

    if (data.lunaImpression) await memory.updateUserOpinion(userId, data.lunaImpression);

    // Track finance topics on the user profile
    const financeKeywords = ['crypto','bitcoin','btc','eth','forex','saham','trading','investasi','komoditas','emas','dolar','altcoin','defi','nft'];
    for (const kw of financeKeywords) {
      if (userMessage.toLowerCase().includes(kw)) {
        await memory.addUserTopic(userId, kw);
      }
    }

  } catch (err) {
    console.error('[Reflect] Non-fatal error:', err.message);
  }
}
