// src/scheduler.js
// Manages periodic conversation initiation across all tracked groups

import cron from 'node-cron';
import { generateInitiation } from './claude.js';

const PROB      = parseFloat(process.env.INITIATE_PROBABILITY || '0.7');
const DELAY_MIN = parseInt(process.env.INITIATE_DELAY_MIN || '3000');
const DELAY_MAX = parseInt(process.env.INITIATE_DELAY_MAX || '15000');
const CRON_EXPR = process.env.INITIATE_CRON || '0 9,11,13,15,17,19,21 * * *';

const activeGroups = new Set();

export function trackGroup(chatId) {
  activeGroups.add(chatId);
  console.log(`[Scheduler] Tracking group ${chatId} (total: ${activeGroups.size})`);
}

export function untrackGroup(chatId) {
  activeGroups.delete(chatId);
  console.log(`[Scheduler] Untracked group ${chatId}`);
}

export function startScheduler(bot) {
  console.log(`[Scheduler] Cron: "${CRON_EXPR}", probability: ${PROB}`);

  cron.schedule(CRON_EXPR, async () => {
    if (activeGroups.size === 0) return;

    for (const chatId of activeGroups) {
      if (Math.random() > PROB) continue;

      const delay = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);

      setTimeout(async () => {
        try {
          await bot.sendChatAction(chatId, 'typing');
          await sleep(1500 + Math.random() * 2000);
          const message = await generateInitiation(chatId);
          if (message) {
            await bot.sendMessage(chatId, message);
            console.log(`[Scheduler] Sent to ${chatId}: "${message.slice(0, 60)}..."`);
          }
        } catch (err) {
          console.error(`[Scheduler] Error group ${chatId}:`, err.message);
        }
      }, delay);
    }
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
