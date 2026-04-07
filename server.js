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

function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isoToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Team options
const TEAM_OPTIONS = [
  { key: 'PC', label: 'PC' },
  { key: 'AE', label: 'AE' },
  { key: 'LIQUID', label: 'LIQUID' },
  { key: 'HDI', label: 'HDI' },
  { key: 'AOS_CCV_EDM', label: 'AOS/CCV/EDM' },
  { key: 'CAF', label: 'CAF' },
  { key: 'NEV', label: 'NEV' },
  { key: 'SIMULATION', label: 'SIMULATION' }
];

function isValidTeamKey(teamKey) {
  return TEAM_OPTIONS.some(t => t.key === teamKey);
}

function teamLabelFromKey(teamKey) {
  const found = TEAM_OPTIONS.find(t => t.key === teamKey);
  return found ? found.label : teamKey;
}

// Calendar callback data
// action format: <MODE>_<TEAMKEY>
function calCb(action, type, value) {
  return `CAL|${action}|${type}|${value}`;
}

function buildCalendarKeyboard(action, y, mo) {
  const firstDow = weekdayOfFirst(y, mo);
  const dim = daysInMonth(y, mo);
  const mondayFirstOffset = (firstDow + 6) % 7;

  const rows = [];
  rows.push([Markup.button.callback(`Calendar: ${monthLabel(y, mo)}`, calCb(action, 'NAV', `${y}-${pad2(mo)}`))]);

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
    Markup.button.callback('< Prev', calCb(action, 'NAV', `${prev.y}-${pad2(prev.mo)}`)),
    Markup.button.callback('Next >', calCb(action, 'NAV', `${next.y}-${pad2(next.mo)}`))
  ]);

  return Markup.inlineKeyboard(rows);
}

async function saveEntry(store, tgId, dateISO, mode, team) {
  store.entries = store.entries || {};
  store.entries[dateISO] = store.entries[dateISO] || {};
  store.entries[dateISO][String(tgId)] = {
    mode, // WFH | OFFICE | OOO
    team, // PC | AE | LIQUID | HDI | AOS/CCV/EDM | CAF | NEV | SIMULATION
    ts: new Date().toISOString()
  };
}

// Bot
const bot = new Telegraf(BOT_TOKEN);

// In group: stay silent. In DM: show help.
bot.start(async (ctx) => {
  if (isGroup(ctx)) return;

  return ctx.reply(
    'Commands:\n' +
    '/wfh - select Team then pick a date (DM only)\n' +
    '/office - select Team then pick a date (DM only)\n' +
    '/ooo - select Team then pick a date (DM only)\n\n' +
    'To view everyone\'s status, use the web dashboard:\n' +
    `${BASE_URL}/dashboard`
  );
});

// Team picker keyboard
function teamKeyboard(mode) {
  const rows = TEAM_OPTIONS.map(t => [
    Markup.button.callback(t.label, `TEAM|${mode}|${t.key}`)
  ]);
  return Markup.inlineKeyboard(rows);
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
  return ctx.reply('Pick a date:', kb);
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

// Team selection: only allow in private
bot.action(/^TEAM\|(WFH|OFFICE|OOO)\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPrivate(ctx)) return;

  const mode = ctx.match[1];
  const team = ctx.match[2];

  if (!isValidTeamKey(team)) return;

  return openCalendar(ctx, `${mode}_${team}`);
});

// Calendar navigation
bot.action(/^CAL\|((?:WFH|OFFICE|OOO)_[A-Z_]+)\|NAV\|(\d{4}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPrivate(ctx)) return;

  const action = ctx.match[1];
  const [yStr, mStr] = ctx.match[2].split('-');
  const y = Number(yStr);
  const mo = Number(mStr);

  const kb = buildCalendarKeyboard(action, y, mo);
  return ctx.editMessageReplyMarkup(kb.reply_markup);
});

// Calendar pick
bot.action(/^CAL\|((?:WFH|OFFICE|OOO)_[A-Z_]+)\|PICK\|(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPrivate(ctx)) return;

  const action = ctx.match[1];
  const dateISO = ctx.match[2];

  if (!parseISODate(dateISO)) return ctx.reply('Invalid date.');

  const firstUnderscore = action.indexOf('_');
  const mode = action.slice(0, firstUnderscore);
  const teamKey = action.slice(firstUnderscore + 1);

  if (!isValidTeamKey(teamKey)) {
    return ctx.reply('Invalid team.');
  }

  try {
    const store = await readStore();

    await withWriteLock(async () => {
      await ensureUser(store, ctx.from);
      await saveEntry(store, ctx.from.id, dateISO, mode, teamLabelFromKey(teamKey));
      await writeStore(store);
    });

    const modeLabel = mode === 'OOO' ? 'Out Of Office' : mode;
    const savedTeamLabel = teamLabelFromKey(teamKey);

    return ctx.reply(
      `Saved: ${modeLabel} (${savedTeamLabel}) for ${dateISO}. You can change it anytime.\n\n` +
      `Dashboard: ${BASE_URL}/dashboard`
    );
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

//
// Public Web API + Dashboard
//

app.get('/api/status', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, message: 'Invalid date. Use YYYY-MM-DD' });
    }

    const store = await readStore();
    const users = store.users || {};
    const dayEntries = (store.entries && store.entries[date]) ? store.entries[date] : {};

    const rows = Object.entries(users)
      .map(([tgId, u]) => {
        const entry = dayEntries[tgId];
        return {
          name: u.name || tgId,
          username: u.username || null,
          team: entry?.team || null,
          status: entry?.mode || 'NOT_SET',
          updatedAt: entry?.ts || null
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ ok: true, date, rows });
  } catch (e) {
    console.error('API_STATUS_ERROR', e?.message, e?.response?.status);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

app.get('/api/status-range', async (req, res) => {
  try {
    const from = req.query.from || isoToday();
    if (!isISODate(from)) {
      return res.status(400).json({ ok: false, message: 'Invalid from date. Use YYYY-MM-DD' });
    }

    const store = await readStore();
    const users = store.users || {};
    const entriesByDate = store.entries || {};

    const dates = Object.keys(entriesByDate)
      .filter(isISODate)
      .filter(d => d >= from)
      .sort();

    const days = dates.map(date => {
      const dayEntries = entriesByDate[date] || {};

      const rows = Object.entries(dayEntries)
        .map(([tgId, entry]) => {
          const u = users[tgId] || {};
          return {
            tgId,
            name: u.name || tgId,
            username: u.username || null,
            team: entry?.team || null,
            status: entry?.mode || 'NOT_SET',
            updatedAt: entry?.ts || null
          };
        })
        .filter(r => r.status !== 'NOT_SET' || r.team)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      return { date, rows };
    }).filter(day => day.rows.length > 0);

    res.json({ ok: true, from, days });
  } catch (e) {
    console.error('API_STATUS_RANGE_ERROR', e?.message, e?.response?.status);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

app.get('/dashboard', (req, res) => {
  res.type('html').send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>WFH Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .muted { color: #666; }
    .day { margin-top: 18px; }
    .day h3 { margin: 0 0 8px 0; }
    table { border-collapse: collapse; width: 100%; margin-top: 6px; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { background: #f4f4f4; text-align: left; }
    .pill { display:inline-block; padding:2px 8px; border-radius: 999px; font-size: 12px; }
    .WFH { background:#e8f3ff; }
    .OFFICE { background:#e9f9ee; }
    .OOO { background:#fff2e6; }
  </style>
</head>
<body>
  <h2>Hybrid Status Dashboard</h2>
  <div class="muted" id="info">Loading...</div>
  <div id="root"></div>

<script>
  function isoToday() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return yyyy + '-' + mm + '-' + dd;
  }

  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday:'short', year:'numeric', month:'short', day:'numeric' });
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function fmtStatus(s) {
    if (s === 'OFFICE') return 'Office';
    if (s === 'WFH') return 'WFH';
    if (s === 'OOO') return 'Out Of Office';
    return s || 'Not set';
  }

  async function load() {
    const from = isoToday();
    const r = await fetch('/api/status-range?from=' + encodeURIComponent(from));
    const j = await r.json();

    const root = document.getElementById('root');
    root.innerHTML = '';

    if (!j.ok) {
      document.getElementById('info').textContent = 'Error: ' + (j.message || 'unknown');
      return;
    }

    const totalRows = (j.days || []).reduce((sum, d) => sum + (d.rows?.length || 0), 0);
    document.getElementById('info').textContent =
      'Showing from ' + j.from + ' • ' + (j.days?.length || 0) + ' day(s) • ' + totalRows + ' entry(ies)';

    if (!j.days || j.days.length === 0) {
      root.innerHTML = '<p class="muted">No future entries found from today.</p>';
      return;
    }

    for (const day of j.days) {
      const wrap = document.createElement('div');
      wrap.className = 'day';

      const h = document.createElement('h3');
      h.textContent = fmtDate(day.date) + ' (' + day.date + ')';
      wrap.appendChild(h);

      const table = document.createElement('table');
      table.innerHTML = \`
        <thead>
          <tr>
            <th>Name</th>
            <th>Team</th>
            <th>Status</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody></tbody>
      \`;

      const tbody = table.querySelector('tbody');

      for (const row of (day.rows || [])) {
        const status = row.status || 'NOT_SET';
        const updated = row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '-';
        const team = row.team || '-';

        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + esc(row.name) + '</td>' +
          '<td>' + esc(team) + '</td>' +
          '<td><span class="pill ' + esc(status) + '">' + esc(fmtStatus(status)) + '</span></td>' +
          '<td>' + esc(updated) + '</td>';

        tbody.appendChild(tr);
      }

      wrap.appendChild(table);
      root.appendChild(wrap);
    }
  }

  load();
</script>
</body>
</html>
  `);
});

// Health
app.get('/', (req, res) => res.status(200).send('OK'));

// Webhook: explicit POST handler
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
