require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const app = express();
app.use(express.json());
// DEBUG: show current webhook info from Telegram
app.get('/debug/webhook', async (req, res) => {
  try {
    const r = await axios.get(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getWebhookInfo`);
    res.json(r.data);
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e?.message,
      status: e?.response?.status,
      data: e?.response?.data
    });
  }
});

// DEBUG: force set webhook to BASE_URL + WEBHOOK_PATH
app.get('/debug/setwebhook', async (req, res) => {
  try {
    const url = `${process.env.BASE_URL}${process.env.WEBHOOK_PATH || '/telegram/webhook'}`;
    const r = await axios.get(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/setWebhook`, {
      params: { url }
    });
    res.json({ url, telegram: r.data });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e?.message,
      status: e?.response?.status,
      data: e?.response?.data
    });
  }
});

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;              // e.g. https://yourapp.onrender.com
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram/webhook';

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;

if (!BOT_TOKEN || !BASE_URL || !JSONBIN_BIN_ID || !JSONBIN_API_KEY) {
  throw new Error('Missing env vars: BOT_TOKEN, BASE_URL, JSONBIN_BIN_ID, JSONBIN_API_KEY');
}

// JSONbin
const JSONBIN_BASE = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

async function readStore() {
  try {
    const res = await axios.get(`${JSONBIN_BASE}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY },
      timeout: 15000
    });
    return res.data.record;
  } catch (e) {
    console.error('JSONBIN_READ_ERROR', {
      message: e?.message,
      code: e?.code,
      status: e?.response?.status,
      statusText: e?.response?.statusText
    });
    throw e;
  }
}


async function writeStore(store) {
  try {
    await axios.put(JSONBIN_BASE, store, {
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_API_KEY,
        'X-Bin-Versioning': 'true'
      },
      timeout: 15000
    });
  } catch (e) {
    console.error('JSONBIN_WRITE_ERROR', {
      message: e?.message,
      code: e?.code,
      status: e?.response?.status,
      statusText: e?.response?.statusText
    });
    throw e;
  }
}


// Serialize writes to avoid collisions when many users click at once
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
    store.users[id] = {
      name: displayName(from),
      username: from.username || null
    };
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
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

// IST âtodayâ for default calendar month
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
  return new Date(y, mo, 0).getDate(); // mo is 1-12
}

function weekdayOfFirst(y, mo) {
  // 0=Sun..6=Sat
  return new Date(y, mo - 1, 1).getDay();
}

function monthLabel(y, mo) {
  const dt = new Date(y, mo - 1, 1);
  return dt.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Calendar callback data format:
 *  CAL|<action>|NAV|<y>-<m>
 *  CAL|<action>|PICK|<yyyy-mm-dd>
 * action: WFH | OFFICE | VIEW
 */
function calCb(action, type, value) {
  return `CAL|${action}|${type}|${value}`;
}

function buildCalendarKeyboard(action, y, mo) {
  const firstDow = weekdayOfFirst(y, mo); // 0 Sun..6 Sat
  const dim = daysInMonth(y, mo);

  // Monday-first offset: Mon=0..Sun=6
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

async function saveEntry(store, tgId, dateISO, mode) {
  store.entries = store.entries || {};
  store.entries[dateISO] = store.entries[dateISO] || {};
  store.entries[dateISO][String(tgId)] = {
    mode, // "WFH" or "OFFICE"
    ts: new Date().toISOString()
  };
}

// Bot
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const store = await readStore();
  await withWriteLock(async () => {
    await ensureUser(store, ctx.from);
    await writeStore(store);
  });

  return ctx.reply(
    'Commands:\n' +
    '/wfh - pick a date and mark WFH\n' +
    '/office - pick a date and mark Office\n' +
    '/view - pick a date and view everyoneâs status'
  );
});

async function openCalendar(ctx, action) {
  const store = await readStore();
  await withWriteLock(async () => {
    await ensureUser(store, ctx.from);
    await writeStore(store);
  });

  const { y, mo } = nowInISTParts();
  const kb = buildCalendarKeyboard(action, y, mo);

  const title =
    action === 'WFH' ? 'Pick a date to mark WFH:' :
    action === 'OFFICE' ? 'Pick a date to mark Office:' :
    'Pick a date to view everyoneâs status:';

  return ctx.reply(title, kb);
}

bot.command('wfh', (ctx) => openCalendar(ctx, 'WFH'));
bot.command('office', (ctx) => openCalendar(ctx, 'OFFICE'));
bot.command('view', (ctx) => openCalendar(ctx, 'VIEW'));

// Calendar navigation
bot.action(/^CAL\|(WFH|OFFICE|VIEW)\|NAV\|(\d{4}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const action = ctx.match[1];
  const ym = ctx.match[2];
  const [yStr, mStr] = ym.split('-');
  const y = Number(yStr);
  const mo = Number(mStr);

  const kb = buildCalendarKeyboard(action, y, mo);
  return ctx.editMessageReplyMarkup(kb.reply_markup);
});

// Calendar pick
bot.action(/^CAL\|(WFH|OFFICE|VIEW)\|PICK\|(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const action = ctx.match[1];
  const dateISO = ctx.match[2];

  if (!parseISODate(dateISO)) return ctx.reply('Invalid date.');

  const store = await readStore();

  // Ensure user exists (so they appear in "known users")
  await withWriteLock(async () => {
    await ensureUser(store, ctx.from);

    if (action !== 'VIEW') {
      await saveEntry(store, ctx.from.id, dateISO, action); // action is WFH or OFFICE
    }

    await writeStore(store);
  });

  if (action === 'VIEW') {
    const users = store.users || {};
    const dayEntries = (store.entries && store.entries[dateISO]) ? store.entries[dateISO] : {};

    const office = [];
    const wfh = [];
    const notSet = [];

    const known = Object.entries(users)
      .map(([tgId, u]) => ({ tgId, name: u.name || tgId }))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const u of known) {
      const entry = dayEntries[u.tgId];
      if (!entry) {
        notSet.push(u.name);
      } else if (entry.mode === 'OFFICE') {
        office.push(u.name);
      } else if (entry.mode === 'WFH') {
        wfh.push(u.name);
      } else {
        notSet.push(u.name);
      }
    }

    const msg =
      `Status for ${dateISO} (IST)\n\n` +
      `Office (${office.length}):\n${office.join('\n') || '-'}\n\n` +
      `WFH (${wfh.length}):\n${wfh.join('\n') || '-'}\n\n` +
      `Not set (${notSet.length}):\n${notSet.join('\n') || '-'}`;

    return ctx.reply(msg);
  }

  return ctx.reply(`Saved: ${action} for ${dateISO}. You can change it anytime via /wfh or /office.`);
});

// Webhook + health
app.post('/telegram/webhook', (req, res, next) => {
  console.log('INCOMING UPDATE:', JSON.stringify(req.body));
  next();
});
app.post('/telegram/webhook', (req, res, next) => {
  console.log('TELEGRAM_UPDATE_RECEIVED');
  next();
});

app.use(bot.webhookCallback(WEBHOOK_PATH));
app.get('/', (req, res) => res.status(200).send('OK'));
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED_REJECTION:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION:', err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  const webhookUrl = `${BASE_URL}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl);
  console.log(`Listening on ${PORT}. Webhook set to ${webhookUrl}`);
});
bot.command('menu', async (ctx) => {
  return ctx.reply(
    'Choose an option:',
    Markup.inlineKeyboard([
      [Markup.button.callback('WFH (pick date)', 'OPEN_WFH')],
      [Markup.button.callback('Office (pick date)', 'OPEN_OFFICE')],
      [Markup.button.callback('View (pick date)', 'OPEN_VIEW')]
    ])
  );
});

bot.action('OPEN_WFH', async (ctx) => {
  await ctx.answerCbQuery();
  return openCalendar(ctx, 'WFH');
});

bot.action('OPEN_OFFICE', async (ctx) => {
  await ctx.answerCbQuery();
  return openCalendar(ctx, 'OFFICE');
});

bot.action('OPEN_VIEW', async (ctx) => {
  await ctx.answerCbQuery();
  return openCalendar(ctx, 'VIEW');
});
app.get('/telegram/webhook', (req, res) => {
  res.status(200).send('Webhook endpoint is up (GET). Telegram uses POST.');
});

