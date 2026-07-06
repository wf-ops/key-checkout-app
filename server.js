require('dotenv').config();
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { Readable } = require('stream');
const multer = require('multer');
const { google } = require('googleapis');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
// Slack events need raw body for signature verification — skip JSON parsing for that route
app.use((req, res, next) => {
  if (req.path === '/api/slack/events') return express.raw({ type: '*/*' })(req, res, next);
  express.json()(req, res, next);
});
app.use(session({
  secret: process.env.SESSION_SECRET || 'krb-key-app-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const userRole = (req.session.user.role || '').toLowerCase();
    if (!roles.map(r => r.toLowerCase()).includes(userRole)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function uploadToDrive(buffer, originalname, mimetype) {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive'] });
  const drive = google.drive({ version: 'v3', auth });
  const ext = path.extname(originalname) || '.jpg';
  const filename = `key-photo-${Date.now()}${ext}`;
  const file = await drive.files.create({
    requestBody: { name: filename, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: mimetype || 'image/jpeg', body: Readable.from(buffer) },
    fields: 'id,webViewLink',
  });
  await drive.permissions.create({ fileId: file.data.id, requestBody: { role: 'reader', type: 'anyone' } });
  return { fileId: file.data.id, url: file.data.webViewLink };
}

async function downloadFileFromDrive(fileId) {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive'] });
  const drive = google.drive({ version: 'v3', auth });
  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  const mimeType = ((response.headers && response.headers['content-type']) || 'image/jpeg').split(';')[0];
  return { base64: buffer.toString('base64'), mimeType };
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';

const DB = {
  keys: 'bb222b13-e089-42ec-9458-9f1800c06bd8',
  log: '6493156c-9348-45a5-9632-0552edda23b5',
  properties: '2d161a46-cdef-80a8-aae1-cf5bb3f0fb0b',
  staff: '32243e9b-6fd7-407e-8baf-55bfa320408d',
  lockboxes: '30a61a46-cdef-804e-88fb-fff4404cf3b6',
  kwiksetCuts: '30a61a46-cdef-80b1-aa2b-e6cb42560512',
};

const CODEBOX_BASE = 'https://api02.codeboxinc.com';
let codeboxToken = null;
let codeboxTokenExp = 0;
let codeboxAuthInFlight = null;

async function getCodeboxToken() {
  if (codeboxToken && Date.now() < codeboxTokenExp - 60000) return codeboxToken;
  if (!codeboxAuthInFlight) {
    codeboxAuthInFlight = (async () => {
      const res = await fetch(`${CODEBOX_BASE}/authentication`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Username: process.env.CODEBOX_USERNAME, Password: process.env.CODEBOX_PASSWORD }),
      });
      const rawText = await res.text();
      console.log(`[Codebox auth] status=${res.status} body=${rawText.slice(0, 120)}`);
      if (!res.ok) throw new Error(`Codebox auth failed: ${res.status} ${rawText}`);
      let token;
      let parsed;
      try { parsed = JSON.parse(rawText); } catch (_) { parsed = null; }
      if (parsed !== null && typeof parsed === 'object') {
        token = parsed.AuthToken || parsed.authToken || parsed.token || parsed.Token || parsed.access_token || parsed.AccessToken;
        if (!token) throw new Error('No token field in Codebox auth response: ' + rawText.slice(0, 200));
      } else {
        token = (typeof parsed === 'string' ? parsed : rawText).trim().replace(/^"|"$/g, '');
      }
      let exp = Date.now() + 3600000;
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          if (payload.exp) exp = payload.exp * 1000;
        }
      } catch (_) {}
      console.log(`[Codebox auth] token acquired, expires in ${Math.round((exp - Date.now()) / 60000)}min`);
      codeboxToken = token;
      codeboxTokenExp = exp;
      return token;
    })().finally(() => { codeboxAuthInFlight = null; });
  }
  return codeboxAuthInFlight;
}

function codeboxHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-Auth-Token': token,
  };
}

function notionHeaders() {
  return {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionPost(url, body) {
  const res = await fetch(url, { method: 'POST', headers: notionHeaders(), body: JSON.stringify(body) });
  if (!res.ok) { const text = await res.text(); throw new Error(`Notion API ${res.status}: ${text}`); }
  return res.json();
}

async function notionPatch(url, body) {
  const res = await fetch(url, { method: 'PATCH', headers: notionHeaders(), body: JSON.stringify(body) });
  if (!res.ok) { const text = await res.text(); throw new Error(`Notion API ${res.status}: ${text}`); }
  return res.json();
}

async function queryAll(dbId, filter, sorts) {
  const results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    const data = await notionPost(`https://api.notion.com/v1/databases/${dbId}/query`, body);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function extractRichText(prop) {
  if (!prop) return '';
  if (prop.type === 'rich_text') return prop.rich_text.map(r => r.plain_text).join('');
  if (prop.type === 'title') return prop.title.map(r => r.plain_text).join('');
  if (prop.type === 'number') return prop.number != null ? String(prop.number) : '';
  return '';
}
function extractSelect(prop) {
  if (!prop || prop.type !== 'select') return '';
  return prop.select?.name || '';
}
function extractMultiSelect(prop) {
  if (!prop || prop.type !== 'multi_select') return [];
  return prop.multi_select.map(s => s.name);
}

const MT_TZ = 'America/Boise';
function mtDateStr(date = new Date()) { return date.toLocaleDateString('en-CA', { timeZone: MT_TZ }); }
function mtTimestamp(date = new Date()) { return date.toLocaleString('en-US', { timeZone: MT_TZ }); }
function codeboxDateStr(date = new Date()) {
  return date.toLocaleDateString('en-US', { timeZone: MT_TZ, month: '2-digit', day: '2-digit', year: 'numeric' });
}

// --- Auth ---
app.post('/api/login', async (req, res) => {
  try {
    const { username, pin } = req.body;
    if (!username || !pin) return res.status(400).json({ error: 'Username and PIN required' });
    const rows = await queryAll(DB.staff, { property: 'Username', rich_text: { equals: username.toLowerCase().trim() } });
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid username or PIN' });
    const user = rows[0];
    if (!user.properties['Active']?.checkbox) return res.status(401).json({ error: 'Account is inactive' });
    const hash = user.properties['PIN Hash']?.rich_text?.[0]?.plain_text || '';
    if (!await bcrypt.compare(pin, hash)) return res.status(401).json({ error: 'Invalid username or PIN' });
    req.session.user = {
      id: user.id,
      name: user.properties['Name']?.title?.[0]?.plain_text || username,
      username: username.toLowerCase().trim(),
      role: user.properties['Role']?.select?.name || 'Member',
      notionPersonId: user.properties['Notion Person ID']?.rich_text?.[0]?.plain_text || '',
    };
    res.json({ success: true, user: req.session.user });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

app.post('/api/change-pin', requireAuth, async (req, res) => {
  try {
    const { currentPin, newPin } = req.body;
    if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
    const rows = await queryAll(DB.staff, { property: 'Username', rich_text: { equals: req.session.user.username } });
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    const hash = user.properties['PIN Hash']?.rich_text?.[0]?.plain_text || '';
    if (!await bcrypt.compare(currentPin, hash)) return res.status(401).json({ error: 'Current PIN is incorrect' });
    const newHash = await bcrypt.hash(newPin, 10);
    await notionPatch(`https://api.notion.com/v1/pages/${user.id}`, { properties: { 'PIN Hash': { rich_text: [{ text: { content: newHash } }] } } });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/user-list', async (req, res) => {
  try {
    const rows = await queryAll(DB.staff, { property: 'Active', checkbox: { equals: true } });
    const users = rows.map(r => ({
      username: extractRichText(r.properties['Username']),
      name: extractRichText(r.properties['Name']),
    })).filter(u => u.username);
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', requireRole('Admin'), async (req, res) => {
  try {
    const rows = await queryAll(DB.staff, { property: 'Active', checkbox: { equals: true } });
    const users = rows.map(u => ({
      id: u.id,
      name: u.properties['Name']?.title?.[0]?.plain_text || '',
      username: u.properties['Username']?.rich_text?.[0]?.plain_text || '',
      role: u.properties['Role']?.select?.name || 'Member',
      active: u.properties['Active']?.checkbox || false,
      notionPersonId: u.properties['Notion Person ID']?.rich_text?.[0]?.plain_text || '',
    }));
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireRole('Admin'), async (req, res) => {
  try {
    const { name, username, pin, role, notionPersonId } = req.body;
    if (!name || !username || !pin || !role) return res.status(400).json({ error: 'name, username, pin, and role are required' });
    const hash = await bcrypt.hash(pin, 10);
    const page = await notionPost('https://api.notion.com/v1/pages', {
      parent: { database_id: DB.staff },
      properties: {
        'Name': { title: [{ text: { content: name } }] },
        'Username': { rich_text: [{ text: { content: username.toLowerCase().trim() } }] },
        'PIN Hash': { rich_text: [{ text: { content: hash } }] },
        'Role': { select: { name: role } },
        'Notion Person ID': { rich_text: [{ text: { content: notionPersonId || '' } }] },
        'Active': { checkbox: true },
      },
    });
    res.json({ success: true, id: page.id });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id', requireRole('Admin'), async (req, res) => {
  try {
    const { role, active, pin, name, username, notionPersonId } = req.body;
    const props = {};
    if (role !== undefined) props['Role'] = { select: { name: role } };
    if (active !== undefined) props['Active'] = { checkbox: active };
    if (pin) props['PIN Hash'] = { rich_text: [{ text: { content: await bcrypt.hash(pin, 10) } }] };
    if (name) props['Name'] = { title: [{ text: { content: name } }] };
    if (username) props['Username'] = { rich_text: [{ text: { content: username.toLowerCase().trim() } }] };
    if (notionPersonId !== undefined) props['Notion Person ID'] = { rich_text: [{ text: { content: notionPersonId } }] };
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.id}`, { properties: props });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireRole('Admin'), async (req, res) => {
  try {
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.id}`, { properties: { 'Active': { checkbox: false } } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/properties', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.properties, null, [{ property: 'Property Code', direction: 'ascending' }]);
    const props = rows.map(r => {
      const p = r.properties;
      return { id: r.id, name: extractRichText(p['Street Address - Property']) || extractRichText(p['Property Code']), code: extractRichText(p['Property Code']) };
    }).filter(p => p.name);
    res.json(props);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search-properties', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const rows = await queryAll(DB.properties, {
      or: [
        { property: 'Street Address - Property', rich_text: { contains: q } },
        { property: 'Property Code', rich_text: { contains: q } },
      ],
    }, [{ property: 'Property Code', direction: 'ascending' }]);
    const results = rows.map(r => {
      const p = r.properties;
      return { id: r.id, address: extractRichText(p['Street Address - Property']), propertyCode: extractRichText(p['Property Code']) };
    }).filter(p => p.address || p.propertyCode);
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/keys', requireAuth, async (req, res) => {
  try {
    const { propertyId } = req.query;
    const filter = propertyId ? { property: 'Rental Matrix', relation: { contains: propertyId } } : undefined;
    const rows = await queryAll(DB.keys, filter);
    const keys = rows.map(row => {
      const p = row.properties;
      const rawStatus = extractSelect(p['Status']);
      const keyTypes = extractMultiSelect(p['Key Types']);
      return {
        id: row.id,
        tag: extractRichText(p['Key Tag #']),
        name: keyTypes.join(', ') || 'Key',
        status: rawStatus === 'In Office' ? 'Available' : rawStatus,
        keyTypes,
      };
    });
    res.json(keys);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/checked-out-keys', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.keys, { property: 'Status', select: { equals: 'Checked Out' } });
    const keys = await Promise.all(rows.map(async row => {
      const p = row.properties;
      const tag = extractRichText(p['Key Tag #']);
      const keyTypes = extractMultiSelect(p['Key Types']);
      let propertyName = '';
      const propRel = p['Rental Matrix']?.relation || [];
      if (propRel.length > 0) {
        try {
          const propPage = await fetch(`https://api.notion.com/v1/pages/${propRel[0].id}`, { headers: notionHeaders() }).then(r => r.json());
          propertyName = extractRichText(propPage.properties?.['Street Address - Property']) || extractRichText(propPage.properties?.['Property Code']) || '';
        } catch (_) {}
      }
      return { id: row.id, tag, name: keyTypes.join(', ') || 'Key', keyTypes, propertyName };
    }));
    res.json(keys.filter(k => k.tag));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/log', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const rows = await queryAll(DB.log, null, [{ property: 'Date Out', direction: 'descending' }]);
    const entries = await Promise.all(rows.slice(0, limit).map(async row => {
      const p = row.properties;
      const title = p['Log Entry']?.title?.map(t => t.plain_text).join('') || '';
      const keyTagMatch = title.match(/Key #?([^\s-]+)/);
      const keyTag = keyTagMatch ? keyTagMatch[1] : '';
      const staffName = p['Checked Out By']?.people?.[0]?.name || '';
      const dateOut = p['Date Out']?.date?.start || null;
      const dateReturned = p['Date Returned']?.date?.start || null;
      let propertyName = '';
      const propRelation = p['Property']?.relation || [];
      if (propRelation.length > 0) {
        try {
          const propPage = await fetch(`https://api.notion.com/v1/pages/${propRelation[0].id}`, { headers: notionHeaders() }).then(r => r.json());
          propertyName = extractRichText(propPage.properties?.['Street Address - Property']) || extractRichText(propPage.properties?.['Property Code']) || '';
        } catch (_) {}
      }
      return { id: row.id, propertyName: propertyName || title, keyTag, staffName, timestamp: dateReturned || dateOut, action: dateReturned ? 'Check In' : 'Check Out' };
    }));
    res.json(entries);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/missing-keys', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.log, { property: 'Date Returned', date: { is_empty: true } });
    const entries = await Promise.all(rows.map(async row => {
      const p = row.properties;
      const title = p['Log Entry']?.title?.map(t => t.plain_text).join('') || '';
      const keyTagMatch = title.match(/Key #?([^\s-]+)/);
      const keyTag = keyTagMatch ? keyTagMatch[1] : '';
      const staffName = p['Checked Out By']?.people?.[0]?.name || '';
      const dateOut = p['Date Out']?.date?.start || null;
      let propertyName = '';
      const propRelation = p['Property']?.relation || [];
      if (propRelation.length > 0) {
        try {
          const propPage = await fetch(`https://api.notion.com/v1/pages/${propRelation[0].id}`, { headers: notionHeaders() }).then(r => r.json());
          propertyName = extractRichText(propPage.properties?.['Street Address - Property']) || extractRichText(propPage.properties?.['Property Code']) || '';
        } catch (_) {}
      }
      const daysOut = dateOut ? Math.floor((Date.now() - new Date(dateOut).getTime()) / 86400000) : null;
      const keyRelation = p['Key']?.relation || [];
      const keyId = keyRelation[0]?.id || null;
      return { id: row.id, keyId, keyTag, staffName, dateOut, daysOut, propertyName };
    }));
    res.json(entries.filter(e => e.keyTag || e.propertyName));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /api/resolve-missing — mark a missing key as returned or lost
app.post('/api/resolve-missing', requireRole('Admin', 'Manager', 'Property Manager'), async (req, res) => {
  try {
    const { logId, keyId, resolution } = req.body;
    if (!logId) return res.status(400).json({ error: 'logId required' });
    if (!['returned', 'lost'].includes(resolution)) return res.status(400).json({ error: 'resolution must be "returned" or "lost"' });

    // Close the log entry with today's date
    await notionPatch(`https://api.notion.com/v1/pages/${logId}`, {
      properties: { 'Date Returned': { date: { start: mtDateStr() } } },
    });

    // Update key status if we have the key ID
    if (keyId) {
      const newStatus = resolution === 'lost' ? 'Lost' : 'In Office';
      await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, {
        properties: { 'Status': { select: { name: newStatus } } },
      });
    }

    res.json({ success: true });
  } catch (e) { console.error('[resolve-missing]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/staff', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.staff, { property: 'Active', checkbox: { equals: true } });
    const staff = rows.map(r => ({
      id: r.properties['Notion Person ID']?.rich_text?.[0]?.plain_text || '',
      notionPageId: r.id,
      name: r.properties['Name']?.title?.[0]?.plain_text || '',
    })).filter(s => s.name);
    res.json(staff);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/upload-photo — stores photo in Drive, returns fileId
app.post('/api/upload-photo', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo provided' });
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return res.status(503).json({ error: 'Google Drive not configured' });
    const result = await uploadToDrive(req.file.buffer, req.file.originalname || 'photo.jpg', req.file.mimetype || 'image/jpeg');
    res.json(result);
  } catch (e) { console.error('[upload-photo]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/verify-checkin-photo — AI comparison of checkout vs return photo
app.post('/api/verify-checkin-photo', requireAuth, async (req, res) => {
  try {
    const { keyId, checkInFileId } = req.body;
    if (!keyId || !checkInFileId) return res.status(400).json({ error: 'keyId and checkInFileId required' });

    // Find the active log entry and retrieve checkout photo file ID
    const keyPage = await fetch(`https://api.notion.com/v1/pages/${keyId}`, { headers: notionHeaders() }).then(r => r.json());
    const logRelation = keyPage.properties?.['Key Check-In/ Check-Out Log']?.relation || [];
    let checkoutFileId = null;
    for (const rel of [...logRelation].reverse()) {
      try {
        const logPage = await fetch(`https://api.notion.com/v1/pages/${rel.id}`, { headers: notionHeaders() }).then(r => r.json());
        if (!logPage.properties?.['Date Returned']?.date) {
          checkoutFileId = logPage.properties?.['Photo File ID']?.rich_text?.[0]?.plain_text || null;
          break;
        }
      } catch (_) {}
    }

    if (!checkoutFileId) {
      return res.json({ skipped: true, message: 'No checkout photo on file — cannot compare' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({ skipped: true, message: 'AI verification not configured (ANTHROPIC_API_KEY missing)' });
    }

    const [checkoutImg, checkInImg] = await Promise.all([
      downloadFileFromDrive(checkoutFileId),
      downloadFileFromDrive(checkInFileId),
    ]);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: checkoutImg.mimeType, data: checkoutImg.base64 } },
            { type: 'image', source: { type: 'base64', media_type: checkInImg.mimeType, data: checkInImg.base64 } },
            { type: 'text', text: 'Image 1: keys being checked out. Image 2: keys being returned. Compare them. Do the same keys appear in both? Consider key count, shapes, colors, and any visible tags or labels. Respond with JSON only (no markdown): {"match": true or false, "confidence": "high" or "medium" or "low", "keyCountOut": number or null, "keyCountIn": number or null, "notes": "brief explanation"}' },
          ],
        }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error('Claude API error: ' + errText.slice(0, 120));
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '{}';
    let result;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      result = m ? JSON.parse(m[0]) : { match: true, confidence: 'low', notes: text };
    } catch (_) {
      result = { match: true, confidence: 'low', notes: text };
    }
    console.log('[verify-checkin-photo] result:', JSON.stringify(result));
    res.json(result);
  } catch (e) { console.error('[verify-checkin-photo]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/lockbox-code/:id', requireAuth, async (req, res) => {
  try {
    const lockboxPage = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: notionHeaders() }).then(r => r.json());
    if (lockboxPage.object === 'error') return res.status(404).json({ error: 'Lockbox not found' });
    const sn = extractRichText(lockboxPage.properties?.['Lockbox SN']);
    if (!sn) return res.status(404).json({ error: 'Lockbox serial number not found' });
    if (!process.env.CODEBOX_USERNAME || !process.env.CODEBOX_PASSWORD) return res.status(503).json({ error: 'Codebox credentials not configured' });
    const token = await getCodeboxToken();
    const today = codeboxDateStr();
    const snInt = parseInt(sn, 10);
    const cbRes = await fetch(`${CODEBOX_BASE}/showing`, {
      method: 'POST',
      headers: codeboxHeaders(token),
      body: JSON.stringify({ SerialNumber: snInt, DateOfShowing: today }),
    });
    const rawText = await cbRes.text();
    console.log(`[Codebox] SN=${sn} status=${cbRes.status} body=${rawText}`);
    let data;
    try { data = JSON.parse(rawText); } catch (_) { data = rawText; }
    if (!cbRes.ok) return res.status(cbRes.status).json({ error: (typeof data === 'object' ? data?.Message || data?.message : null) || rawText || 'Codebox error' });
    const code = typeof data === 'object' ? (data.Code || data.code) : null;
    res.json({ code: code || rawText });
  } catch (e) { console.error('[Codebox] error:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/kwikset-options', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.kwiksetCuts, null, [{ property: 'Kwikset Key #', direction: 'ascending' }]);
    const options = rows.map(r => {
      const titleProp = Object.values(r.properties || {}).find(prop => prop.type === 'title');
      const name = titleProp?.title?.[0]?.plain_text || '';
      return { id: r.id, name };
    }).filter(o => o.name);
    res.json(options);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

const PROPERTY_CODE_FIELDS = {
  frontDoorCode: { notion: 'Front Door Code', type: 'number' },
  garageKeypad: { notion: 'Garage Keypad', type: 'text' },
  communityEntryCode: { notion: 'Community Entry Code', type: 'text' },
};

app.get('/api/property-codes/:propertyId', requireAuth, async (req, res) => {
  try {
    const [propPage, keyRows] = await Promise.all([
      fetch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, { headers: notionHeaders() }).then(r => r.json()),
      queryAll(DB.keys, { property: 'Rental Matrix', relation: { contains: req.params.propertyId } }),
    ]);
    if (propPage.object === 'error') throw new Error(propPage.message);
    const p = propPage.properties;
    let kwiksetCut = '';
    let kwiksetCutId = '';
    const kwiksetRel = p['Kwikset Cut']?.relation || [];
    if (kwiksetRel.length > 0) {
      kwiksetCutId = kwiksetRel[0].id;
      try {
        const kwPage = await fetch(`https://api.notion.com/v1/pages/${kwiksetCutId}`, { headers: notionHeaders() }).then(r => r.json());
        const titleProp = Object.values(kwPage.properties || {}).find(prop => prop.type === 'title');
        kwiksetCut = titleProp?.title?.[0]?.plain_text || '';
      } catch (_) {}
    }
    const keys = keyRows.map(row => {
      const kp = row.properties;
      return { id: row.id, tag: extractRichText(kp['Key Tag #']), status: extractSelect(kp['Status']), keyTypes: extractMultiSelect(kp['Key Types']) };
    });
    res.json({
      address: extractRichText(p['Street Address - Property']),
      propertyCode: extractRichText(p['Property Code']),
      frontDoorCode: p['Front Door Code']?.number != null ? String(p['Front Door Code'].number) : extractRichText(p['Front Door Code']),
      garageKeypad: extractRichText(p['Garage Keypad']),
      communityEntryCode: extractRichText(p['Community Entry Code']),
      kwiksetCut, kwiksetCutId, keys,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/property-codes/:propertyId', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { field, value } = req.body;
    const fieldDef = PROPERTY_CODE_FIELDS[field];
    if (!fieldDef) return res.status(400).json({ error: 'Unknown field: ' + field });
    const propValue = fieldDef.type === 'number'
      ? { number: value !== '' && value != null ? Number(value) : null }
      : { rich_text: [{ text: { content: value || '' } }] };
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, {
      properties: { [fieldDef.notion]: propValue },
    });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/property-kwikset/:propertyId', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { kwiksetPageId, previousKwiksetId } = req.body;
    const props = { 'Kwikset Cut': { relation: kwiksetPageId ? [{ id: kwiksetPageId }] : [] } };
    if (previousKwiksetId) {
      const propPage = await fetch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, { headers: notionHeaders() }).then(r => r.json());
      const existing = propPage.properties?.['Previous Kwiksets']?.relation || [];
      if (!existing.some(r => r.id === previousKwiksetId)) {
        props['Previous Kwiksets'] = { relation: [...existing, { id: previousKwiksetId }] };
      }
    }
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, { properties: props });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /api/checkout — requires checkoutFileId (Drive file ID of key photo)
app.post('/api/checkout', requireAuth, async (req, res) => {
  try {
    const { keyId, staffId, propertyId, checkoutFileId } = req.body;
    if (!keyId || !propertyId) return res.status(400).json({ error: 'keyId and propertyId required' });
    const keyPage = await fetch(`https://api.notion.com/v1/pages/${keyId}`, { headers: notionHeaders() }).then(r => r.json());
    const keyTag = extractRichText(keyPage.properties?.['Key Tag #']) || '?';
    const existingLogRelation = keyPage.properties?.['Key Check-In/ Check-Out Log']?.relation || [];
    const logProps = {
      'Log Entry': { title: [{ text: { content: `Key #${keyTag} - ${mtTimestamp()}` } }] },
      'Date Out': { date: { start: mtDateStr() } },
      'Property': { relation: [{ id: propertyId }] },
    };
    if (staffId) { try { logProps['Checked Out By'] = { people: [{ id: staffId }] }; } catch (_) {} }
    // Include checkout photo file ID if provided (graceful — won't fail if field doesn't exist in Notion)
    if (checkoutFileId) {
      try { logProps['Photo File ID'] = { rich_text: [{ text: { content: checkoutFileId } }] }; } catch (_) {}
    }
    let logPage;
    try {
      logPage = await notionPost('https://api.notion.com/v1/pages', { parent: { database_id: DB.log }, properties: logProps });
    } catch (e) {
      // If Photo File ID field doesn't exist, retry without it
      if (checkoutFileId && e.message.includes('Photo File ID')) {
        delete logProps['Photo File ID'];
        logPage = await notionPost('https://api.notion.com/v1/pages', { parent: { database_id: DB.log }, properties: logProps });
      } else { throw e; }
    }
    await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, {
      properties: {
        'Status': { select: { name: 'Checked Out' } },
        'Key Check-In/ Check-Out Log': { relation: [...existingLogRelation, { id: logPage.id }] },
      },
    });
    res.json({ success: true, logId: logPage.id });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /api/checkin — accepts checkInFileId for return photo storage
app.post('/api/checkin', requireAuth, async (req, res) => {
  try {
    const { keyId, checkInFileId } = req.body;
    if (!keyId) return res.status(400).json({ error: 'keyId required' });
    const keyPage = await fetch(`https://api.notion.com/v1/pages/${keyId}`, { headers: notionHeaders() }).then(r => r.json());
    const logRelation = keyPage.properties?.['Key Check-In/ Check-Out Log']?.relation || [];
    let activeLogId = null;
    for (const rel of [...logRelation].reverse()) {
      try {
        const logPage = await fetch(`https://api.notion.com/v1/pages/${rel.id}`, { headers: notionHeaders() }).then(r => r.json());
        if (!logPage.properties?.['Date Returned']?.date) { activeLogId = rel.id; break; }
      } catch (_) {}
    }
    await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, { properties: { 'Status': { select: { name: 'In Office' } } } });
    if (activeLogId) {
      const logUpdateProps = { 'Date Returned': { date: { start: mtDateStr() } } };
      if (checkInFileId) {
        try { logUpdateProps['Return Photo File ID'] = { rich_text: [{ text: { content: checkInFileId } }] }; } catch (_) {}
      }
      try {
        await notionPatch(`https://api.notion.com/v1/pages/${activeLogId}`, { properties: logUpdateProps });
      } catch (e) {
        // Retry without photo field if it doesn't exist
        if (checkInFileId && e.message.includes('Return Photo File ID')) {
          await notionPatch(`https://api.notion.com/v1/pages/${activeLogId}`, { properties: { 'Date Returned': { date: { start: mtDateStr() } } } });
        } else { throw e; }
      }
    }
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
async function sendSlackAlert(message) {
  if (!SLACK_WEBHOOK_URL) return;
  try { await fetch(SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message }) }); }
  catch (e) { console.error('Slack alert failed:', e.message); }
}

async function checkOverdueKeys() {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const today = mtDateStr();
    const rows = await queryAll(DB.log, { and: [{ property: 'Date Returned', date: { is_empty: true } }, { property: 'Date Out', date: { before: today } }] });
    const overdue = rows.filter(row => {
      const p = row.properties;
      const title = p['Log Entry']?.title?.map(t => t.plain_text).join('') || '';
      const dateDue = p['Date Out']?.date?.end || p['Date Out']?.date?.start;
      if (!title || !dateDue) return false;
      return new Date(dateDue) < new Date(today);
    });
    if (overdue.length === 0) { console.log('Daily check: no overdue keys'); return; }
    const lines = overdue.map(row => {
      const p = row.properties;
      const dateDue = p['Date Out']?.date?.end || p['Date Out']?.date?.start || '';
      const daysLate = Math.floor((new Date(today) - new Date(dateDue)) / 86400000);
      const who = p['Checked Out By']?.people?.map(u => u.name).join(', ') || '?';
      const title = p['Log Entry']?.title?.map(t => t.plain_text).join('') || 'Unknown key';
      return `• *${title}* — checked out by ${who} | Due: ${dateDue} *(${daysLate} day${daysLate !== 1 ? 's' : ''} overdue)*`;
    });
    await sendSlackAlert(`🔑 *KRB Overdue Key Alert* — ${overdue.length} key${overdue.length !== 1 ? 's' : ''} past due:\n${lines.join('\n')}`);
    console.log(`Slack: sent overdue alert for ${overdue.length} key(s)`);
  } catch (e) { console.error('checkOverdueKeys error:', e.message); }
}

function scheduleDailyOverdueCheck() {
  const now = new Date();
  const mtParts = new Intl.DateTimeFormat('en-US', { timeZone: MT_TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const mtHour = parseInt(mtParts.find(p => p.type === 'hour').value);
  const mtMin = parseInt(mtParts.find(p => p.type === 'minute').value);
  const secsUntil = mtHour < 8 ? (8 - mtHour) * 3600 - mtMin * 60 : (24 - mtHour + 8) * 3600 - mtMin * 60;
  console.log(`Daily overdue check scheduled in ${Math.round(secsUntil / 60)} min (next 8 AM MT)`);
  setTimeout(async () => {
    await checkOverdueKeys().catch(e => console.error('Daily overdue check failed:', e.message));
    scheduleDailyOverdueCheck();
  }, secsUntil * 1000);
}

app.post('/api/test-slack', requireRole('Admin'), async (req, res) => {
  try { await sendSlackAlert('✅ KRB Key App Slack connection test — working!'); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/lockboxes', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.lockboxes, null, [{ property: 'Lockbox SN', direction: 'ascending' }]);
    const seen = new Set();
    const boxes = rows.map(r => {
      const p = r.properties;
      const propRel = p['Last Known Property']?.relation || [];
      return { id: r.id, sn: extractRichText(p['Lockbox SN']), krbBox: p['KRB Key Box #']?.number || null, status: p['Status']?.select?.name || 'Unassigned', propertyId: propRel[0]?.id || null, propertyName: extractRichText(p['Merge']) || null, notes: extractRichText(p['Notes']) };
    }).filter(b => {
      if (!b.sn || seen.has(b.sn)) return false;
      seen.add(b.sn);
      return true;
    });
    res.json(boxes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/lockboxes/:id', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { status, propertyId } = req.body;
    const props = {};
    if (status) props['Status'] = { select: { name: status } };
    if (propertyId !== undefined) props['Last Known Property'] = propertyId ? { relation: [{ id: propertyId }] } : { relation: [] };
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.id}`, { properties: props });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/lockboxes/generate-code', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { serialNumber, date } = req.body;
    if (!serialNumber || !date) return res.status(400).json({ error: 'serialNumber and date required' });
    if (!process.env.CODEBOX_USERNAME || !process.env.CODEBOX_PASSWORD) return res.status(503).json({ error: 'Codebox credentials not configured' });
    const token = await getCodeboxToken();
    const snInt = parseInt(serialNumber, 10);
    const cbRes = await fetch(`${CODEBOX_BASE}/showing`, {
      method: 'POST',
      headers: codeboxHeaders(token),
      body: JSON.stringify({ SerialNumber: snInt, DateOfShowing: date }),
    });
    const rawText = await cbRes.text();
    console.log(`[Codebox generate] SN=${serialNumber} status=${cbRes.status} body=${rawText}`);
    let data;
    try { data = JSON.parse(rawText); } catch (_) { data = rawText; }
    if (!cbRes.ok) return res.status(cbRes.status).json({ error: (typeof data === 'object' ? data?.Message || data?.message : null) || rawText || 'Codebox error' });
    res.json(typeof data === 'object' ? data : { raw: rawText });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Slack Events (lockbox location monitoring)
const crypto = require('crypto');

function verifySlackSignature(req, rawBody) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  const ts = req.headers['x-slack-request-timestamp'];
  if (!ts || Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) return false;
  const sig = req.headers['x-slack-signature'];
  const base = `v0:${ts}:${rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig || ''), Buffer.from(expected));
}

app.post('/api/slack/events', async (req, res) => {
  const rawBody = req.body.toString();
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return res.status(400).send('Bad JSON'); }

  // URL verification challenge from Slack
  if (payload.type === 'url_verification') {
    return res.json({ challenge: payload.challenge });
  }

  // Verify signature
  if (!verifySlackSignature(req, rawBody)) {
    return res.status(403).send('Invalid signature');
  }

  // Acknowledge immediately — Slack requires response within 3s
  res.sendStatus(200);

  // Process in background
  const event = payload.event;
  if (!event || event.type !== 'message' || event.subtype || event.bot_id) return;

  const channelName = process.env.SLACK_LOCKBOX_CHANNEL || 'lockboxes';
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return;

  // Check it's the right channel
  try {
    const chanRes = await fetch(`https://slack.com/api/conversations.info?channel=${event.channel}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    }).then(r => r.json());
    if (!chanRes.ok || chanRes.channel?.name !== channelName) return;
  } catch { return; }

  const messageText = event.text || '';
  const hasFiles = event.files && event.files.length > 0;

  // Download image if present
  let imageBase64 = null, imageMime = null;
  if (hasFiles && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const file = event.files[0];
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      try {
        const imgRes = await fetch(file.url_private, { headers: { Authorization: `Bearer ${botToken}` } });
        const buf = Buffer.from(await imgRes.arrayBuffer());
        imageBase64 = buf.toString('base64');
        imageMime = file.mimetype;
      } catch (e) { console.error('[slack-events] image download failed:', e.message); }
    }
  }

  if (!messageText && !imageBase64) return;
  await processLockboxMessage({ text: messageText, imageBase64, imageMime }, botToken);
});

// Shared: parse a Slack message and update Notion lockbox accordingly
async function processLockboxMessage({ text, imageBase64, imageMime }, botToken) {
  if (!text && !imageBase64) return null;

  // Fetch lockbox list for context
  let lbRows = [];
  try { lbRows = await queryAll(DB.lockboxes, null); } catch { return null; }
  const seen = new Set();
  const lockboxSNs = lbRows.map(r => extractRichText(r.properties?.['Lockbox SN'])).filter(sn => { if (!sn || seen.has(sn)) return false; seen.add(sn); return true; });

  // Ask Claude to parse the message
  const claudeContent = [];
  if (imageBase64) claudeContent.push({ type: 'image', source: { type: 'base64', media_type: imageMime, data: imageBase64 } });
  claudeContent.push({ type: 'text', text: `You are helping manage lockbox assignments for a property management company. Known lockbox serial numbers: ${lockboxSNs.join(', ')}.

Slack message text: "${text || '(no text)'}"
${imageBase64 ? 'An image is also attached — carefully read any serial number label visible on the lockbox in the photo.' : ''}

Your job:
1. Find the lockbox serial number — check BOTH the message text AND any image label. Serial numbers are 8 digits. Match against the known list if possible.
2. Find a property address or name mentioned (could be a street address, partial address like "2208 state st", or property name).
3. Determine if the lockbox is being PLACED at a property (assigned) or REMOVED/picked up (removed). If a photo shows a lockbox at a property with an address mentioned, assume assigned.

Return JSON only (no markdown):
{"action": "assigned" or "removed" or "unknown", "lockboxSN": "serial number string or null", "propertyHint": "address or name or null", "confidence": "high" or "medium" or "low", "snSource": "text" or "image" or null}

Use confidence=high when both SN and property are clear. confidence=medium when SN is clear but property is vague or vice versa. confidence=low when both are uncertain.` });

  let parsed;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: claudeContent }] }),
    });
    const claudeData = await claudeRes.json();
    const t = claudeData.content?.[0]?.text || '{}';
    const m = t.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch (e) { console.error('[slack] Claude parse failed:', e.message); return null; }

  if (!parsed || !['high', 'medium'].includes(parsed.confidence) || !parsed.lockboxSN || parsed.action === 'unknown') {
    return { skipped: true, reason: 'low confidence or missing info', parsed };
  }

  const lbRow = lbRows.find(r => extractRichText(r.properties?.['Lockbox SN']) === parsed.lockboxSN);
  if (!lbRow) return { skipped: true, reason: 'SN not found in Notion', sn: parsed.lockboxSN };

  let propertyId = null;
  if (parsed.propertyHint && parsed.action === 'assigned') {
    const propRows = await queryAll(DB.properties, {
      or: [
        { property: 'Street Address - Property', rich_text: { contains: parsed.propertyHint } },
        { property: 'Property Code', rich_text: { contains: parsed.propertyHint } },
      ],
    }).catch(() => []);
    if (propRows.length > 0) propertyId = propRows[0].id;
  }

  const updateProps = {};
  if (parsed.action === 'assigned') {
    updateProps['Status'] = { select: { name: 'At Property' } };
    if (propertyId) updateProps['Last Known Property'] = { relation: [{ id: propertyId }] };
  } else if (parsed.action === 'removed') {
    updateProps['Status'] = { select: { name: 'In Office' } };
  }

  try {
    await notionPatch(`https://api.notion.com/v1/pages/${lbRow.id}`, { properties: updateProps });
    console.log(`[slack] updated lockbox ${parsed.lockboxSN} → ${parsed.action}${propertyId ? ' at ' + parsed.propertyHint : ''}`);
    return { updated: true, sn: parsed.lockboxSN, action: parsed.action, property: parsed.propertyHint };
  } catch (e) {
    console.error('[slack] Notion update failed:', e.message);
    return { error: e.message };
  }
}

// POST /api/slack/backfill — process last 60 days of #lockboxes messages
app.post('/api/slack/backfill', requireRole('Admin'), async (req, res) => {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelName = process.env.SLACK_LOCKBOX_CHANNEL || 'lockboxes';
  if (!botToken) return res.status(503).json({ error: 'SLACK_BOT_TOKEN not configured' });

  // Find channel ID by name — paginate through all channels
  let channelId;
  try {
    let listCursor;
    let found = null;
    do {
      let url = 'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200';
      if (listCursor) url += `&cursor=${listCursor}`;
      const listRes = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } }).then(r => r.json());
      if (!listRes.ok) return res.status(400).json({ error: `Slack API error: ${listRes.error}`, hint: 'Check SLACK_BOT_TOKEN and that the bot has channels:read scope' });
      found = listRes.channels?.find(c => c.name === channelName);
      listCursor = listRes.response_metadata?.next_cursor;
      if (found) break;
    } while (listCursor);
    if (!found) return res.status(404).json({ error: `Channel #${channelName} not found — make sure the bot is invited to the channel (/invite @BotName in Slack)` });
    channelId = found.id;
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const oldest = Math.floor((Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000);
  const results = { updated: 0, skipped: 0, errors: 0, total: 0 };

  // Stream response so it doesn't time out
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');

  let cursor;
  let done = false;
  while (!done) {
    let url = `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${oldest}&limit=100`;
    if (cursor) url += `&cursor=${cursor}`;
    const histRes = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } }).then(r => r.json());
    if (!histRes.ok) { results.errors++; break; }

    for (const msg of (histRes.messages || [])) {
      if (msg.subtype || msg.bot_id) continue;
      results.total++;

      let imageBase64 = null, imageMime = null;
      if (msg.files?.length > 0) {
        const f = msg.files[0];
        if (f.mimetype?.startsWith('image/')) {
          try {
            const imgRes = await fetch(f.url_private, { headers: { Authorization: `Bearer ${botToken}` } });
            const buf = Buffer.from(await imgRes.arrayBuffer());
            imageBase64 = buf.toString('base64');
            imageMime = f.mimetype;
          } catch (_) {}
        }
      }

      const result = await processLockboxMessage({ text: msg.text || '', imageBase64, imageMime }, botToken);
      if (!result) { results.skipped++; continue; }
      if (result.updated) results.updated++;
      else if (result.skipped) results.skipped++;
      else results.errors++;
    }

    cursor = histRes.response_metadata?.next_cursor;
    if (!cursor) done = true;
  }

  res.end(JSON.stringify({ success: true, ...results }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KRB Key App running on http://localhost:${PORT}`);
  scheduleDailyOverdueCheck();
  if (!SLACK_WEBHOOK_URL) console.warn('⚠️  SLACK_WEBHOOK_URL not set — Slack alerts disabled');
});
