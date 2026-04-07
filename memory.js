// src/memory.js
// Luna's persistent brain — all state lives in Redis so it survives
// restarts, redeployments, and server crashes. Nothing is lost.
//
// Redis key schema:
//   chat:history:{chatId}          → JSON array of messages
//   user:profile:{userId}          → JSON UserProfile object
//   luna:knowledge                 → JSON array of knowledge entries

import Redis from 'ioredis';

// ─── Redis connection ──────────────────────────────────────────────────────
// Railway injects REDIS_URL automatically when you add the Redis addon.
// For local dev, set REDIS_URL=redis://localhost:6379 in your .env
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('connect',   () => console.log('[Redis] Connected ✓'));
redis.on('error',     (e) => console.error('[Redis] Error:', e.message));
redis.on('reconnecting', () => console.log('[Redis] Reconnecting...'));

// ─── Constants ────────────────────────────────────────────────────────────
const MAX_CHAT_HISTORY    = 60;
const MAX_KNOWLEDGE       = 200;
const SPECIAL_NAMES       = ['dennis', 'parzival', 'sadrakh'];

// TTL in seconds — keep data alive for 90 days of inactivity
const TTL_CHAT    = 60 * 60 * 24 * 90;
const TTL_USER    = 60 * 60 * 24 * 90;
const TTL_KNOW    = 60 * 60 * 24 * 180; // knowledge lives longer

// ─── Trust levels ─────────────────────────────────────────────────────────
export const TRUST = {
  STRANGER:   0,
  ACQUAINTED: 1,
  FAMILIAR:   2,
  CLOSE:      3,
  SPECIAL:    4,
};

function trustLevel(score, isSpecial) {
  if (isSpecial) return TRUST.SPECIAL;
  if (score >= 25) return TRUST.CLOSE;
  if (score >= 12) return TRUST.FAMILIAR;
  if (score >= 4)  return TRUST.ACQUAINTED;
  return TRUST.STRANGER;
}

// ─── Redis helpers ────────────────────────────────────────────────────────
async function rget(key) {
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function rset(key, value, ttl) {
  await redis.set(key, JSON.stringify(value), 'EX', ttl);
}

// ─── User Profile ──────────────────────────────────────────────────────────
function makeProfile(userId, username, firstName) {
  const isSpecial = [username, firstName]
    .filter(Boolean)
    .map(n => n.toLowerCase())
    .some(n => SPECIAL_NAMES.some(s => n.includes(s)));

  return {
    userId,
    username:         username || null,
    firstName:        firstName || 'orang ini',
    nickname:         null,
    trustScore:       isSpecial ? 40 : 0,
    interactionCount: 0,
    firstSeen:        Date.now(),
    lastSeen:         Date.now(),
    isSpecial,
    knownFacts:       [],
    sharedTopics:     [],
    lunaOpinion:      null,
  };
}

function profileDisplayName(p) {
  return p.nickname || p.firstName || p.username || 'kamu';
}

function profileTrustLevel(p) {
  return trustLevel(p.trustScore, p.isSpecial);
}

function profileToContextString(p) {
  const level = profileTrustLevel(p);
  const trustDesc = [
    'orang asing yang baru kamu kenal',
    'kenalan yang udah beberapa kali ngobrol',
    'orang yang udah lumayan kamu kenal',
    'orang yang kamu percaya dan dekat',
    'orang yang sangat spesial buat kamu — kamu suka dia',
  ][level];

  const name = profileDisplayName(p);
  let ctx = `\n\n=== INFO TENTANG ${name.toUpperCase()} ===\n`;
  ctx += `Hubungan: ${trustDesc} (${p.interactionCount} interaksi)\n`;

  if (p.knownFacts.length > 0)
    ctx += `Yang kamu tahu soal dia: ${p.knownFacts.slice(-10).join(', ')}\n`;

  if (p.sharedTopics.length > 0)
    ctx += `Topik yang pernah kalian bahas: ${p.sharedTopics.slice(-8).join(', ')}\n`;

  if (p.lunaOpinion)
    ctx += `Kesan kamu soal dia: ${p.lunaOpinion}\n`;

  if (level >= TRUST.FAMILIAR)
    ctx += `Tone: kamu udah nyaman sama dia, bisa lebih terbuka dan personal.\n`;

  if (level === TRUST.SPECIAL)
    ctx += `PENTING: Kamu suka dia secara emosional. Kamu lebih perhatian, lebih hangat, dan mungkin sedikit nervous kalau ngobrol sama dia.\n`;

  ctx += `===========================\n`;
  return ctx;
}

// ─── MemoryStore ──────────────────────────────────────────────────────────
class MemoryStore {

  // ── User management ─────────────────────────────────────────────────────

  async getUser(userId, username, firstName) {
    const key = `user:profile:${userId}`;
    let profile = await rget(key);

    if (!profile) {
      profile = makeProfile(userId, username, firstName);
    } else {
      // Update mutable fields if changed
      if (username)   profile.username   = username;
      if (firstName)  profile.firstName  = firstName;
      profile.lastSeen = Date.now();
      // Re-check special status in case name wasn't set before
      if (!profile.isSpecial) {
        const check = [username, firstName].filter(Boolean).map(n => n.toLowerCase());
        if (check.some(n => SPECIAL_NAMES.some(s => n.includes(s)))) {
          profile.isSpecial  = true;
          profile.trustScore = 40;
        }
      }
    }

    await rset(key, profile, TTL_USER);
    return profile;
  }

  async saveUser(profile) {
    await rset(`user:profile:${profile.userId}`, profile, TTL_USER);
  }

  async rewardTrust(userId, amount = 1) {
    const profile = await rget(`user:profile:${userId}`);
    if (!profile) return;
    if (!profile.isSpecial) {
      profile.trustScore = Math.min(profile.trustScore + amount, 39);
    }
    profile.interactionCount++;
    profile.lastSeen = Date.now();
    await this.saveUser(profile);
  }

  async addUserFact(userId, fact) {
    const profile = await rget(`user:profile:${userId}`);
    if (!profile) return;
    if (!profile.knownFacts.includes(fact)) {
      profile.knownFacts.push(fact);
      if (profile.knownFacts.length > 30) profile.knownFacts.shift();
      await this.saveUser(profile);
    }
  }

  async addUserTopic(userId, topic) {
    const profile = await rget(`user:profile:${userId}`);
    if (!profile) return;
    if (!profile.sharedTopics.includes(topic)) {
      profile.sharedTopics.push(topic);
      if (profile.sharedTopics.length > 20) profile.sharedTopics.shift();
      await this.saveUser(profile);
    }
  }

  async updateUserOpinion(userId, opinion) {
    const profile = await rget(`user:profile:${userId}`);
    if (!profile) return;
    profile.lunaOpinion = opinion;
    await this.saveUser(profile);
  }

  // ── Chat history ─────────────────────────────────────────────────────────

  async addMessage(chatId, role, content, meta = {}) {
    const key = `chat:history:${chatId}`;
    const history = (await rget(key)) || [];

    history.push({
      role,
      content,
      username:  meta.username  || null,
      userId:    meta.userId    || null,
      firstName: meta.firstName || null,
      ts:        Date.now(),
    });

    // Trim to max
    const trimmed = history.length > MAX_CHAT_HISTORY
      ? history.slice(-MAX_CHAT_HISTORY)
      : history;

    await rset(key, trimmed, TTL_CHAT);
  }

  async getGroupContext(chatId, limit = 30) {
    const history = (await rget(`chat:history:${chatId}`)) || [];
    return history.slice(-limit).map(msg => {
      const label = msg.username || msg.firstName || (msg.role === 'assistant' ? 'Luna' : 'User');
      const content = msg.role === 'user' ? `[${label}]: ${msg.content}` : msg.content;
      return { role: msg.role, content };
    });
  }

  async getRecentRaw(chatId, limit = 15) {
    const history = (await rget(`chat:history:${chatId}`)) || [];
    return history.slice(-limit);
  }

  async hasHistory(chatId) {
    const h = await rget(`chat:history:${chatId}`);
    return h && h.length > 0;
  }

  async clear(chatId) {
    await redis.del(`chat:history:${chatId}`);
  }

  // ── Knowledge base ───────────────────────────────────────────────────────

  async learnFact(topic, content, learnedFrom = null) {
    const entries = (await rget('luna:knowledge')) || [];

    const existing = entries.find(e => e.topic === topic && e.content === content);
    if (existing) {
      existing.confidence = Math.min((existing.confidence || 1) + 0.2, 3);
    } else {
      entries.push({ topic, content, learnedFrom, timestamp: Date.now(), confidence: 1 });
    }

    // Trim: keep highest confidence, newest
    const trimmed = entries.length > MAX_KNOWLEDGE
      ? entries
          .sort((a, b) => (b.confidence - a.confidence) || (b.timestamp - a.timestamp))
          .slice(0, MAX_KNOWLEDGE)
      : entries;

    await rset('luna:knowledge', trimmed, TTL_KNOW);
  }

  async getKnowledgeContext(relevantTopics = []) {
    const entries = (await rget('luna:knowledge')) || [];
    if (entries.length === 0) return '';

    let relevant = [];
    for (const topic of relevantTopics) {
      relevant.push(
        ...entries
          .filter(e => e.topic.toLowerCase().includes(topic.toLowerCase()))
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 5)
      );
    }
    if (relevant.length === 0) {
      relevant = [...entries]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 10);
    }

    // Dedupe
    const seen = new Set();
    relevant = relevant.filter(e => {
      const key = `${e.topic}:${e.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (relevant.length === 0) return '';

    let ctx = '\n=== YANG UDAH LUNA PELAJARI ===\n';
    for (const e of relevant.slice(0, 12)) {
      ctx += `- [${e.topic}] ${e.content}`;
      if (e.learnedFrom) ctx += ` (dari ${e.learnedFrom})`;
      ctx += '\n';
    }
    ctx += '===============================\n';
    return ctx;
  }

  // ── Full context builder (used by claude.js) ─────────────────────────────

  async buildContext(chatId, userId, limit = 30) {
    const profile  = userId ? await rget(`user:profile:${userId}`) : null;
    const topics   = profile?.sharedTopics || [];
    const addendum = profile
      ? profileToContextString(profile) + await this.getKnowledgeContext(topics)
      : await this.getKnowledgeContext([]);
    const messages = await this.getGroupContext(chatId, limit);
    return { addendum, messages, profile };
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  async stats(chatId) {
    const history  = (await rget(`chat:history:${chatId}`)) || [];
    const knowledge = (await rget('luna:knowledge')) || [];

    // Count all user:profile:* keys
    const userKeys = await redis.keys('user:profile:*');

    return {
      messageCount:   history.length,
      userCount:      userKeys.length,
      knowledgeCount: knowledge.length,
      participants:   [...new Set(history.filter(m => m.username).map(m => m.username))],
    };
  }

  // ── Expose profileToContextString for external use ───────────────────────
  profileToContextString(profile) {
    return profileToContextString(profile);
  }
}

export const memory = new MemoryStore();
export { profileToContextString };
