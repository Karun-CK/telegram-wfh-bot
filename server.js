require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const app = express();
app.use(express.json());

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL; // e.g. https://telegram-wfh-bot-gsho.onrender.com
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram/webhook';

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;

if (!BOT_TOKEN || !BASE_URL || !JSONBIN_BIN_ID || !JSONBIN_API_KEY) {
  throw new Error('Missing env vars: BOT_TOKEN, BASE_URL, JSONBIN_BIN_ID, JSONBIN_API_KEY');
}

// Chat type helpers
function isPrivate(ctx) {
  return ctx.chat && ctx.chat.type === 'private';
}
function isGroup(ctx) {
  return ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');
}

// JSONbin
const JSONBIN_BASE = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

async function readStore() {
  const res = await axios.get(`${JSONBIN_BASE}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_API_KEY },
    timeout: 15000
  });
  return res.data.record;
}

async function writeStore(store) {
  // JSONbin Free: do NOT use X-Bin-Versioning
  await axios.put(JSONBIN_BASE, store, {
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': JSONBIN_API_KEY
    },
    timeout: 15000
  });
}

// Serialize writes (avoid collisions)
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
  writeQueue = writeQueue.then(fn).catch(() => fn());
  return writeQueue;
}

// Helpers
function displayName(from) {
  const n = `${from.first_name || ''} ${from.last_name || ''}`.trim();
  return n || from.username || String(from.id);
}

async function ensureUser(store, from) {
  store.users = store.users || {};
  const id = String(from.id);

  if (!store.users[id]) {
    store.users[id] = { name: displayName(from), username: from.username || null };
  } else {
    store.users[id].name = displayName(from);
    store.users[id].username = from.username || store.users[id].username || null;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDateFromParts(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null;
}

// IST month default
function nowInISTParts() {
  const tz = 'Asia/Kolkata';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const y = Number(parts.find(p => p.type === 'year').value);
  const mo = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);
  return { y, mo, d };
}

function daysInMonth(y, mo) {
  return new Date(y, mo, 0).getDate();
}

function weekdayOfFirst(y, mo) {
  return new Date(y, mo - 1, 1).getDay(); // 0 Sun..6 Sat
}

function monthLabel(y, mo) {
  const dt = new Date(y, mo - 1, 1);
  return dt.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// Calendar callback data
// action can be: VIEW or <MODE>_<TEAM> where MODE in {WFH, OFFICE, OOO} and TEAM in {PC, AE}
function calCb(action, type, value) {
  return `CAL|${action}|${type}|${value}`;
}

function buildCalendarKeyboard(action, y, mo) {
  const firstDow = weekdayOfFirst(y, mo);
  const dim = daysInMonth(y, mo);
  const mondayFirstOffset = (firstDow + 6) % 7;

  const rows = [];
  rows.push([Markup.button.callback(`ð ${monthLabel(y, mo)}`, calCb(action, 'NAV', `${y}-${pad2(mo)}`))]);

  rows.push(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(t =>
    Markup.button.callback(t, calCb(action, 'NAV', `${y}-${pad2(mo)}`))
  ));

  let day = 1;
  for (let r = 0; r < 6; r++) {
    const row = [];
    for (let c = 0; c < 7; c++) {
      const cellIndex = r * 7 + c;
      if (cellIndex < mondayFirstOffset || day > dim) {
        row.push(Markup.button.callback(' ', calCb(action, 'NAV', `${y}-${pad2(mo)}`)));
      } else {
        const iso = isoDateFromParts(y, mo, day);
        row.push(Markup.button.callback(String(day), calCb(action, 'PICK', iso)));
        day++;
      }
    }
    rows.push(row);
    if (day > dim) break;
  }

  const prev = mo === 1 ? { y: y - 1, mo: 12 } : { y, mo: mo - 1 };
  const next = mo === 12 ? { y: y + 1, mo: 1 } : { y, mo: mo + 1 };

  rows.push([
    Markup.button.callback('â Prev', calCb(action, 'NAV', `${prev.y}-${pad2(prev.mo)}`)),
    Markup.button.callback('Next â¶', calCb(action, 'NAV', `${next.y}-${pad2(next.mo)}`))
  ]);

  return Markup.inlineKeyboard(rows);
}

async function saveEntry(store, tgId, dateISO, mode, team) {
  store.entries = store.entries || {};
  store.entries[dateISO] = store.entries[dateISO] || {};
  store.entries[dateISO][String(tgId)] = {
    mode, // "WFH" | "OFFICE" | "OOO"
    team, // "PC" | "AE"
    ts: new Date().toISOString()
  };
}

// Bot
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  // In group: stay silent (per your requirement)
  if (isGroup(ctx)) return;

  return ctx.reply(
    'Commands:\n' +
    '/wfh - select Team then pick a date (DM only)\n' +
    '/office - select Team then pick a date (DM only)\n' +
    '/ooo - select Team then pick a date (DM only)\n' +
    '/view - pick a date and view everyoneâs status'
  );
});

// Team picker keyboard
function teamKeyboard(mode) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('PC', `TEAM|${mode}|PC`)],
    [Markup.button.callback('AE', `TEAM|${mode}|AE`)]
  ]);
}

// Send DM silently (no group reply). If DM fails, do nothing.
async function sendSilentDM(ctx, text, extra) {
  try {
    await ctx.telegram.sendMessage(ctx.from.id, text, extra);
  } catch (e) {
    // User hasn't started bot in DM or blocked bot; stay silent as requested.
  }
}

function openCalendar(ctx, action) {
  const { y, mo } = nowInISTParts();
  const kb = buildCalendarKeyboard(action, y, mo);

  const title =
    action === 'VIEW'
      ? 'Pick a date to view everyoneâs status:'
      : 'Pick a date:';

  return ctx.reply(title, kb);
}

// Commands: in group -> DM; in private -> respond normally
bot.command('wfh', async (ctx) => {
  if (isGroup(ctx)) return sendSilentDM(ctx, 'Team (WFH):', teamKeyboard('WFH'));
  return ctx.reply('Team (WFH):', teamKeyboard('WFH'));
});

bot.command('office', async (ctx) => {
  if (isGroup(ctx)) return sendSilentDM(ctx, 'Team (Office):', teamKeyboard('OFFICE'));
  return ctx.reply('Team (Office):', teamKeyboard('OFFICE'));
});

bot.command('ooo', async (ctx) => {
  if (isGroup(ctx)) return sendSilentDM(ctx, 'Team (Out Of Office):', teamKeyboard('OOO'));
  return ctx.reply('Team (Out Of Office):', teamKeyboard('OOO'));
});

// /view: allowed in group and private (group-visible by design)
bot.command('view', (ctx) => openCalendar(ctx, 'VIEW'));

// Team selection: only allow in private (ignore in group)
bot.action(/^TEAM\|(WFH|OFFICE|OOO)\|(PC|AE)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPrivate(ctx)) return;

  const mode = ctx.match[1];
  const team = ctx.match[2];
  return openCalendar(ctx, `${mode}_${team}`);
});

// Calendar navigation
bot.action(/^CAL\|((?:WFH|OFFICE|OOO)_(?:PC|AE)|VIEW)\|NAV\|(\d{4}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const action = ctx.match[1];

  // Prevent navigating status-setting calendars in groups
  if (action !== 'VIEW' && !isPrivate(ctx)) return;

  const [yStr, mStr] = ctx.match[2].split('-');
  const y = Number(yStr);
  const mo = Number(mStr);

  const kb = buildCalendarKeyboard(action, y, mo);
  return ctx.editMessageReplyMarkup(kb.reply_markup);
});

// Calendar pick
bot.action(/^CAL\|((?:WFH|OFFICE|OOO)_(?:PC|AE)|VIEW)\|PICK\|(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const action = ctx.match[1];
  const dateISO = ctx.match[2];

  if (!parseISODate(dateISO)) return ctx.reply('Invalid date.');

  // Block saving actions in groups
  if (action !== 'VIEW' && !isPrivate(ctx)) return;

  try {
    const store = await readStore();

    await withWriteLock(async () => {
      await ensureUser(store, ctx.from);

      if (action !== 'VIEW') {
        const [mode, team] = action.split('_');
        await saveEntry(store, ctx.from.id, dateISO, mode, team);
      }

      await writeStore(store);
    });

    if (action === 'VIEW') {
      const users = store.users || {};
      const dayEntries = (store.entries && store.entries[dateISO]) ? store.entries[dateISO] : {};

      const office = [];
      const wfh = [];
      const ooo = [];
      const notSet = [];

      const known = Object.entries(users)
        .map(([tgId, u]) => ({ tgId, name: u.name || tgId }))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const u of known) {
        const entry = dayEntries[u.tgId];
        if (!entry) {
          notSet.push(u.name);
        } else if (entry.mode === 'OFFICE') {
          office.push(`${u.name} [${entry.team || 'NA'}]`);
        } else if (entry.mode === 'WFH') {
          wfh.push(`${u.name} [${entry.team || 'NA'}]`);
        } else if (entry.mode === 'OOO') {
          ooo.push(`${u.name} [${entry.team || 'NA'}]`);
        } else {
          notSet.push(u.name);
        }
      }

      const msg =
        `Status for ${dateISO} (IST)\n\n` +
        `Office (${office.length}):\n${office.join('\n') || '-'}\n\n` +
        `WFH (${wfh.length}):\n${wfh.join('\n') || '-'}\n\n` +
        `Out Of Office (${ooo.length}):\n${ooo.join('\n') || '-'}\n\n` +
        `Not set (${notSet.length}):\n${notSet.join('\n') || '-'}`;

      return ctx.reply(msg);
    }

    const [mode, team] = action.split('_');
    const modeLabel = mode === 'OOO' ? 'Out Of Office' : mode;
    return ctx.reply(`Saved: ${modeLabel} (${team}) for ${dateISO}. You can change it anytime.`);
  } catch (e) {
    console.error('PICK_HANDLER_ERROR', {
      message: e?.message,
      status: e?.response?.status,
      statusText: e?.response?.statusText,
      data: e?.response?.data
    });
    return ctx.reply(`Storage error (JSONbin). (${e?.response?.status || 'no-status'}) Please try again.`);
  }
});

// Health
app.get('/', (req, res) => res.status(200).send('OK'));

// Webhook: explicit POST handler (reliable on Render)
app.post(WEBHOOK_PATH, (req, res) => bot.handleUpdate(req.body, res));

process.on('unhandledRejection', (reason) => console.error('UNHANDLED_REJECTION:', reason));
process.on('uncaughtException', (err) => console.error('UNCAUGHT_EXCEPTION:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const webhookUrl = `${BASE_URL}${WEBHOOK_PATH}`;
  bot.telegram.setWebhook(webhookUrl)
    .then(() => console.log(`Listening on ${PORT}. Webhook set to ${webhookUrl}`))
    .catch((e) => console.error('SET_WEBHOOK_ERROR', e?.message));
});
