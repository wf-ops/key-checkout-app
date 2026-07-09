require('dotenv').config();
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const multer = require('multer');
const { google } = require('googleapis');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const { Resend } = require('resend');

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
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
  mfProperties: '2f261a46-cdef-803d-b18a-f29bf9b1a9fb',
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
  if (prop.type === 'formula') {
    const f = prop.formula;
    if (f?.type === 'string') return f.string || '';
    if (f?.type === 'number') return f.number != null ? String(f.number) : '';
  }
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

// Debug: test MF Properties DB access
app.get('/api/debug-mf-access', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.mfProperties, null);
    const codes = rows.map(r => extractRichText(r.properties?.['Property Code'])).filter(Boolean);
    res.json({ accessible: true, count: rows.length, codes: codes.slice(0, 10) });
  } catch (e) {
    res.json({ accessible: false, error: e.message });
  }
});

// Debug: inspect first key page's property names
app.get('/api/debug-key-fields', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.keys, {});
    if (!rows.length) return res.json({ error: 'no keys' });
    const fields = Object.entries(rows[0].properties).map(([k, v]) => ({ name: k, type: v.type }));
    // Also find any with MF-related content
    const mfRows = rows.filter(r => {
      const keys = Object.keys(r.properties);
      return keys.some(k => k.toLowerCase().includes('mf') || k.toLowerCase().includes('unit'));
    });
    res.json({ fields, mfRowCount: mfRows.length, mfRowSample: mfRows[0]?.properties ? Object.keys(mfRows[0].properties) : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Search MF Unit Property Codes — MF Unit Property Code is a RELATION to the MF Properties DB
// Approach: query keys DB (integration always has access) for rows with MF Unit Property Code set,
// then fetch the related MF property pages individually and filter by search term.
app.get('/api/search-mf-codes', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    // Search MF Properties DB directly now that integration has access
    const mfProps = await queryAll(DB.mfProperties, {
      or: [
        { property: 'Property Code', title: { contains: q } },
        { property: 'Street Address 1 - Property', rich_text: { contains: q } },
      ],
    });
    const results = mfProps.map(r => {
      const code = extractRichText(r.properties?.['Property Code']);
      const addr = extractRichText(r.properties?.['Street Address 1 - Property']) || code;
      return { mfCode: code, mfPageId: r.id, label: `${addr} (MF Common Area)` };
    }).filter(r => r.mfCode);
    res.json(results);
  } catch (e) {
    console.error('[search-mf-codes] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Remove property by MF code (common area keys only)
// MF Unit Property Code is a relation field — query by relation contains mfPageId
app.post('/api/remove-mf-code', requireAuth, uploadMemory.single('photo'), async (req, res) => {
  try {
    const { mfCode, mfPageId, givenTo } = req.body;
    if (!mfCode && !mfPageId) return res.status(400).json({ error: 'mfCode or mfPageId required' });
    if (!givenTo) return res.status(400).json({ error: 'givenTo required' });
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });

    // If we have a page ID, use relation filter; otherwise look up the page ID first
    let pageId = mfPageId;
    if (!pageId && mfCode) {
      const mfRows = await queryAll(DB.mfProperties, { property: 'Property Code', title: { equals: mfCode } });
      if (mfRows.length) pageId = mfRows[0].id;
    }

    let keyRows = [];
    if (pageId) {
      keyRows = await queryAll(DB.keys, { property: 'MF Unit Property Code', relation: { contains: pageId } });
    }

    await Promise.all(keyRows.map(row =>
      notionPatch(`https://api.notion.com/v1/pages/${row.id}`, {
        properties: {
          'MF Unit Property Code': { relation: [] },
          'Status': { select: { name: 'In Office' } },
        },
      })
    ));
    res.json({ success: true, keysCleared: keyRows.length });
  } catch (e) {
    console.error('[remove-mf-code] error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
    const today = mtDateStr();
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
      // Find active log entry to get Due Date
      let dueDate = null;
      const logRel = p['Key Check-In/ Check-Out Log']?.relation || [];
      for (const rel of [...logRel].reverse()) {
        try {
          const logPage = await fetch(`https://api.notion.com/v1/pages/${rel.id}`, { headers: notionHeaders() }).then(r => r.json());
          if (!logPage.properties?.['Date Returned']?.date) {
            dueDate = logPage.properties?.['Due Date']?.date?.start || null;
            break;
          }
        } catch (_) {}
      }
      const overdue = dueDate ? dueDate < today : false;
      return { id: row.id, tag, name: keyTypes.join(', ') || 'Key', keyTypes, propertyName, dueDate, overdue };
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

// ── App settings (stored in settings.json next to server.js) ──────────────────
// ── Settings stored in Notion database (db1956d8-2980-407e-86cb-0ef6c91a71c9) ─
const SETTINGS_DB_ID = 'db1956d8-2980-407e-86cb-0ef6c91a71c9';

async function readSettings() {
  try {
    const rows = await queryAll(SETTINGS_DB_ID, null);
    console.log('[settings] readSettings rows:', rows.length, rows.map(r => ({
      key: r.properties?.Setting?.title?.[0]?.plain_text,
      valueProp: JSON.stringify(r.properties?.Value),
    })));
    const settings = {};
    for (const row of rows) {
      const key = row.properties?.Setting?.title?.[0]?.plain_text;
      const val = extractRichText(row.properties?.Value);
      if (key) settings[key] = val;
    }
    return settings;
  } catch (e) { console.error('[settings] read error:', e.message, e.stack); return {}; }
}

async function writeSettings(data) {
  const rows = await queryAll(SETTINGS_DB_ID, null);
  console.log('[settings] writeSettings existing rows:', rows.length);
  const existing = {};
  for (const row of rows) {
    const key = row.properties?.Setting?.title?.[0]?.plain_text;
    if (key) existing[key] = row.id;
  }
  for (const [key, value] of Object.entries(data)) {
    const props = {
      Setting: { title: [{ text: { content: key } }] },
      Value: { rich_text: [{ text: { content: String(value ?? '') } }] },
    };
    if (existing[key]) {
      console.log('[settings] patching', key, '=', value, 'id:', existing[key]);
      const r = await notionPatch(`https://api.notion.com/v1/pages/${existing[key]}`, { properties: props });
      console.log('[settings] patch result:', JSON.stringify(r).slice(0, 200));
    } else {
      console.log('[settings] creating new row for', key, '=', value);
      const r = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: notionHeaders(),
        body: JSON.stringify({ parent: { database_id: SETTINGS_DB_ID }, properties: props }),
      }).then(x => x.json());
      console.log('[settings] create result:', JSON.stringify(r).slice(0, 200));
    }
  }
}

app.get('/api/settings', requireRole('Admin'), async (req, res) => {
  try {
    res.json(await readSettings());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/settings', requireRole('Admin'), async (req, res) => {
  try {
    await writeSettings(req.body);
    res.json(await readSettings());
  } catch (e) {
    console.error('[settings] patch endpoint error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Kwikset invoice ────────────────────────────────────────────────────────────
app.post('/api/kwikset-invoice', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { propertyId, kwiksetCut, numKeys, performedBy, includeBase = true, billTo = 'Resident' } = req.body;
    if (!propertyId || !numKeys) return res.status(400).json({ error: 'propertyId and numKeys required' });

    const settings = await readSettings();
    const baseCharge = includeBase ? (parseFloat(settings.kwiksetBaseCharge) || 0) : 0;
    const perKeyCharge = parseFloat(settings.kwiksetPerKeyCharge) || 0;
    const total = baseCharge + (perKeyCharge * parseInt(numKeys, 10));

    // Fetch property details
    const propPage = await fetch(`https://api.notion.com/v1/pages/${propertyId}`, { headers: notionHeaders() }).then(r => r.json());
    const p = propPage.properties || {};
    const address = extractRichText(p['Street Address - Property']) || 'Unknown Property';
    const propertyCode = extractRichText(p['Property Code']) || '';
    const tenantRel = p['Tenants']?.relation || p['Tenant']?.relation || [];
    let tenantName = '';
    if (tenantRel.length > 0) {
      try {
        const tenantPage = await fetch(`https://api.notion.com/v1/pages/${tenantRel[0].id}`, { headers: notionHeaders() }).then(r => r.json());
        const tp = tenantPage.properties || {};
        tenantName = extractRichText(Object.values(tp).find(v => v.type === 'title') || {}) ||
          extractRichText(tp['Name'] || tp['Full Name'] || {});
      } catch (_) {}
    }

    const invoiceDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', year: 'numeric', month: 'long', day: 'numeric' });
    const invoiceNum = `KRB-${Date.now()}`;

    // Build PDF in memory
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    await new Promise(resolve => {
      doc.on('end', resolve);

      // Header
      doc.fontSize(22).font('Helvetica-Bold').text('Keyrenter Boise', { align: 'left' });
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('Kwikset Re-key Invoice', { align: 'left' })
        .moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.5);

      // Invoice meta
      doc.fillColor('#000').fontSize(10);
      const metaY = doc.y;
      doc.text(`Invoice #: ${invoiceNum}`, 50, metaY);
      doc.text(`Date: ${invoiceDate}`, 50);
      doc.moveDown(1);

      // Property block
      doc.font('Helvetica-Bold').text('Property:', 50);
      doc.font('Helvetica').text(address, 50);
      if (propertyCode) doc.text(`Code: ${propertyCode}`, 50);
      if (tenantName) doc.text(`Resident: ${tenantName}`, 50);
      doc.moveDown(1);

      // Change details
      doc.font('Helvetica-Bold').text('Re-key Details:', 50);
      doc.font('Helvetica').text(`Kwikset Cut: ${kwiksetCut || 'N/A'}`, 50);
      doc.text(`Keys Provided to Resident: ${numKeys}`, 50);
      doc.text(`Performed By: ${performedBy || 'Staff'}`, 50);
      doc.moveDown(1);

      // Line items table
      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold');
      doc.text('Description', 50, doc.y, { width: 350 });
      doc.text('Amount', 400, doc.y - doc.currentLineHeight(), { width: 162, align: 'right' });
      doc.moveDown(0.2);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.3);

      doc.font('Helvetica');
      if (includeBase) {
        doc.text('Re-key base charge', 50, doc.y, { width: 350 });
        doc.text(`$${baseCharge.toFixed(2)}`, 400, doc.y - doc.currentLineHeight(), { width: 162, align: 'right' });
        doc.moveDown(0.3);
      }

      doc.text(`Keys provided (${numKeys} × $${perKeyCharge.toFixed(2)})`, 50, doc.y, { width: 350 });
      doc.text(`$${(perKeyCharge * parseInt(numKeys, 10)).toFixed(2)}`, 400, doc.y - doc.currentLineHeight(), { width: 162, align: 'right' });
      doc.moveDown(0.3);

      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold');
      doc.text('Total', 50, doc.y, { width: 350 });
      doc.text(`$${total.toFixed(2)}`, 400, doc.y - doc.currentLineHeight(), { width: 162, align: 'right' });

      const billToNote = billTo === 'KRB'
        ? 'Please process this invoice as an internal KRB expense.'
        : billTo === 'Landlord'
          ? 'Please process this invoice in Appfolio as a charge to the owner/landlord.'
          : 'Please process this invoice in Appfolio as a charge to the resident.';
      doc.moveDown(2);
      doc.font('Helvetica').fillColor('#555').fontSize(9)
        .text(billToNote, { align: 'center' });

      doc.end();
    });

    const pdfBuffer = Buffer.concat(chunks);

    // Send via Resend
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(503).json({ error: 'RESEND_API_KEY not configured' });
    const resend = new Resend(resendKey);
    const { error: sendError } = await resend.emails.send({
      to: 'keyrenter078@invoices.appfolio.com',
      from: process.env.RESEND_FROM_EMAIL || 'noreply@bills.gokrb.com',
      subject: `Re-key Invoice ${invoiceNum} — ${address}`,
      text: `Please find the attached re-key invoice for ${address}.\n\nInvoice #: ${invoiceNum}\nTotal: $${total.toFixed(2)}\nKeys provided: ${numKeys}\nKwikset cut: ${kwiksetCut || 'N/A'}\nPerformed by: ${performedBy || 'Staff'}`,
      attachments: [{
        content: pdfBuffer,
        filename: `invoice-${invoiceNum}.pdf`,
      }],
    });
    if (sendError) throw new Error(sendError.message);

    res.json({ success: true, invoiceNum, total, address });
  } catch (e) {
    console.error('[invoice]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/checkout — requires checkoutFileId (Drive file ID of key photo)
app.post('/api/checkout', requireAuth, async (req, res) => {
  try {
    const { keyId, staffId, propertyId, checkoutFileId, returnBy } = req.body;
    if (!keyId || !propertyId) return res.status(400).json({ error: 'keyId and propertyId required' });
    const keyPage = await fetch(`https://api.notion.com/v1/pages/${keyId}`, { headers: notionHeaders() }).then(r => r.json());
    const keyTag = extractRichText(keyPage.properties?.['Key Tag #']) || '?';
    const existingLogRelation = keyPage.properties?.['Key Check-In/ Check-Out Log']?.relation || [];
    const logProps = {
      'Log Entry': { title: [{ text: { content: `Key #${keyTag} - ${mtTimestamp()}` } }] },
      'Date Out': { date: { start: mtDateStr() } },
      'Property': { relation: [{ id: propertyId }] },
    };
    if (returnBy) {
      try { logProps['Due Date'] = { date: { start: returnBy } }; } catch (_) {}
    }
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
    const baseBoxes = rows.map(r => {
      const p = r.properties;
      const propRel = p['Last Known Property']?.relation || [];
      return { id: r.id, sn: extractRichText(p['Lockbox SN']), krbBox: p['KRB Key Box #']?.number || null, status: p['Status']?.select?.name || 'Unassigned', propertyId: propRel[0]?.id || null, propertyName: extractRichText(p['Merge']) || null, notes: extractRichText(p['Notes']) };
    }).filter(b => {
      if (!b.sn || seen.has(b.sn)) return false;
      seen.add(b.sn);
      return true;
    });
    // For any box missing a propertyName but having a propertyId, fetch the property name
    const needsName = baseBoxes.filter(b => !b.propertyName && b.propertyId);
    if (needsName.length) {
      await Promise.allSettled(needsName.map(async b => {
        try {
          const page = await fetch(`https://api.notion.com/v1/pages/${b.propertyId}`, { headers: notionHeaders() }).then(r => r.json());
          if (page.object !== 'error') {
            b.propertyName = extractRichText(page.properties?.['Street Address - Property']) || extractRichText(page.properties?.['Property Code']) || null;
          }
        } catch {}
      }));
    }
    res.json(baseBoxes);
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
  claudeContent.push({ type: 'text', text: `You are helping manage lockbox assignments for a property management company.

Slack message text: "${text || '(no text)'}"

${imageBase64 ? `IMPORTANT: An image is attached. It shows a physical lockbox device (a CodeBox or similar). There is a white rectangular label sticker on the lockbox body with an 8-digit serial number printed in large black digits (e.g. "10131040" or "20133678"). Read that number carefully from the label — it is the lockboxSN.` : ''}

Known lockbox serial numbers for reference: ${lockboxSNs.join(', ')}.

Tasks:
1. lockboxSN: Read the 8-digit serial number from the image label OR from the message text. Return it as a string. If found in image, prioritize that.
2. propertyHint: Find any property address or name (street address, partial address like "2208 state st", or property name).
3. action: "assigned" (lockbox being placed at a property), "removed" (being picked up/returned), or "unknown".

Return ONLY this JSON (no markdown, no explanation):
{"action":"assigned"|"removed"|"unknown","lockboxSN":"8digits or null","propertyHint":"address or null","confidence":"high"|"medium"|"low","snSource":"text"|"image"|null}

confidence=high: both SN and property clear. confidence=medium: SN clear but property vague (or vice versa). confidence=low: both uncertain.` });

  let parsed;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: claudeContent }] }),
    });
    const claudeData = await claudeRes.json();
    const t = claudeData.content?.[0]?.text || '{}';
    console.log('[claude raw]', t.substring(0, 300), '| hasImage:', !!imageBase64, '| mime:', imageMime);
    if (claudeData.error) {
      console.error('[claude error]', JSON.stringify(claudeData.error));
      if (claudeData.error.type === 'rate_limit_error') return { skipped: true, reason: 'Claude rate limited' };
    }
    const m = t.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch (e) { console.error('[slack] Claude parse failed:', e.message); return null; }

  if (!parsed) return { skipped: true, reason: 'Claude returned no JSON' };
  const snVal = parsed.lockboxSN && parsed.lockboxSN !== 'null' ? parsed.lockboxSN : null;
  if (!snVal) return { skipped: true, reason: 'no SN found', parsed };
  parsed.lockboxSN = snVal;
  // Default unknown action to 'assigned' when SN is found — most #lockboxes photos are placements
  if (parsed.action === 'unknown') parsed.action = 'assigned';
  if (!['high', 'medium'].includes(parsed.confidence)) return { skipped: true, reason: `confidence too low (${parsed.confidence})`, parsed };

  const lbRow = lbRows.find(r => extractRichText(r.properties?.['Lockbox SN']) === parsed.lockboxSN);
  if (!lbRow) return { skipped: true, reason: `SN not in Notion: ${parsed.lockboxSN}` };

  let propertyId = null;
  if (parsed.propertyHint && parsed.action === 'assigned') {
    // Try full hint first, then fall back to just the street number (handles "2208 state st" vs "2208 W State St")
    const streetNum = (parsed.propertyHint.match(/^\d+/) || [])[0];
    const searches = [parsed.propertyHint];
    if (streetNum && streetNum !== parsed.propertyHint) searches.push(streetNum);
    for (const hint of searches) {
      const propRows = await queryAll(DB.properties, {
        or: [
          { property: 'Street Address - Property', rich_text: { contains: hint } },
          { property: 'Property Code', rich_text: { contains: hint } },
        ],
      }).catch(() => []);
      if (propRows.length > 0) { propertyId = propRows[0].id; break; }
    }
  }

  const updateProps = {};
  if (parsed.action === 'assigned') {
    updateProps['Status'] = { select: { name: 'At Property' } };
    if (propertyId) updateProps['LB Location'] = { relation: [{ id: propertyId }] };
  } else if (parsed.action === 'removed') {
    updateProps['Status'] = { select: { name: 'In Office' } };
    // Move current LB Location → Last Known Property, then clear LB Location
    const currentLBLocation = lbRow.properties?.['LB Location']?.relation || [];
    if (currentLBLocation.length > 0) {
      updateProps['Last Known Property'] = { relation: currentLBLocation };
    }
    updateProps['LB Location'] = { relation: [] };
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

// In-memory backfill job state
let backfillJob = null;

async function runBackfill(botToken, channelName) {
  const job = backfillJob;

  // Find channel ID by name
  let channelId;
  try {
    let listCursor;
    let found = null;
    do {
      let url = 'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200';
      if (listCursor) url += `&cursor=${listCursor}`;
      const listRes = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } }).then(r => r.json());
      if (!listRes.ok) { job.error = `Slack API error: ${listRes.error}`; job.done = true; return; }
      found = listRes.channels?.find(c => c.name === channelName);
      listCursor = listRes.response_metadata?.next_cursor;
      if (found) break;
    } while (listCursor);
    if (!found) { job.error = `Channel #${channelName} not found`; job.done = true; return; }
    channelId = found.id;
  } catch (e) { job.error = e.message; job.done = true; return; }

  const oldest = Math.floor((Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000);
  let cursor;
  let done = false;
  while (!done) {
    let url = `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${oldest}&limit=100`;
    if (cursor) url += `&cursor=${cursor}`;
    const histRes = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } }).then(r => r.json());
    if (!histRes.ok) { job.results.errors++; break; }

    for (const msg of (histRes.messages || [])) {
      if (msg.bot_id || (msg.subtype && msg.subtype !== 'file_share')) continue;
      job.results.total++;

      let imageBase64 = null, imageMime = null;
      const fileObj = msg.files?.[0] || msg.file || null;
      if (fileObj) {
        const f = fileObj;
        if (f.mimetype?.startsWith('image/')) {
          console.log('[slack] file fields:', JSON.stringify({ mimetype: f.mimetype, has720: !!f.thumb_720, has360: !!f.thumb_360, has480: !!f.thumb_480 }));
          const imgUrl = f.thumb_720 || f.thumb_480 || f.thumb_360 || f.url_private;
          const usingThumb = !!(f.thumb_720 || f.thumb_480 || f.thumb_360);
          try {
            const imgRes = await fetch(imgUrl, { headers: { Authorization: `Bearer ${botToken}` } });
            if (!imgRes.ok) {
              const k = `image fetch ${imgRes.status}`;
              job.results.skipReasons[k] = (job.results.skipReasons[k] || 0) + 1;
            } else {
              const contentType = imgRes.headers.get('content-type') || '';
              const buf = Buffer.from(await imgRes.arrayBuffer());
              console.log('[slack] img downloaded:', buf.length, 'bytes, thumb:', usingThumb, 'type:', contentType.split(';')[0]);
              if (buf.length < 4096) {
                const k = 'image too small (likely HTML error)';
                job.results.skipReasons[k] = (job.results.skipReasons[k] || 0) + 1;
              } else if (buf.length > 3_500_000) {
                const k = 'image too large for Claude (>3.5MB) — no thumbnail available';
                job.results.skipReasons[k] = (job.results.skipReasons[k] || 0) + 1;
              } else if (!contentType.startsWith('image/') && !contentType.startsWith('application/octet')) {
                const k = `image wrong content-type: ${contentType.split(';')[0]}`;
                job.results.skipReasons[k] = (job.results.skipReasons[k] || 0) + 1;
              } else {
                imageBase64 = buf.toString('base64');
                imageMime = contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/jpeg';
                job.results.withImage++;
              }
            }
          } catch (e) { console.error('[slack] image fetch error:', e.message); }
        }
      }

      // 5 RPM org limit → 13s between image calls
      if (imageBase64) await new Promise(r => setTimeout(r, 13000));
      const result = await processLockboxMessage({ text: msg.text || '', imageBase64, imageMime }, botToken);
      if (!result) { job.results.skipped++; const k = 'no text or image'; job.results.skipReasons[k] = (job.results.skipReasons[k] || 0) + 1; continue; }
      if (result.updated) job.results.updated++;
      else if (result.skipped) {
        job.results.skipped++;
        const k = result.reason || 'unknown';
        job.results.skipReasons[k] = (job.results.skipReasons[k] || 0) + 1;
        if (result.parsed) console.log('[backfill skip]', JSON.stringify(result.parsed));
      }
      else job.results.errors++;
    }

    cursor = histRes.response_metadata?.next_cursor;
    if (!cursor) done = true;
  }

  job.done = true;
}

// POST /api/slack/backfill — start async backfill job
app.post('/api/slack/backfill', requireRole('Admin'), async (req, res) => {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelName = process.env.SLACK_LOCKBOX_CHANNEL || 'lockboxes';
  if (!botToken) return res.status(503).json({ error: 'SLACK_BOT_TOKEN not configured' });
  if (backfillJob && !backfillJob.done) return res.json({ started: false, message: 'Backfill already running', ...backfillJob.results });

  backfillJob = { done: false, error: null, results: { updated: 0, skipped: 0, errors: 0, total: 0, withImage: 0, skipReasons: {} } };
  runBackfill(botToken, channelName).catch(e => { backfillJob.error = e.message; backfillJob.done = true; });
  res.json({ started: true, message: 'Backfill started — poll /api/slack/backfill/status for results' });
});

// GET /api/slack/backfill/status — poll for backfill progress
app.get('/api/slack/backfill/status', requireRole('Admin'), (req, res) => {
  if (!backfillJob) return res.json({ started: false });
  res.json({ done: backfillJob.done, error: backfillJob.error, success: true, ...backfillJob.results });
});

// ── Remove Property ───────────────────────────────────────────────────────────
// Accepts multipart: propertyId, givenTo, photo (file)

app.post('/api/remove-property', requireAuth, uploadMemory.single('photo'), async (req, res) => {
  try {
    const { propertyId, givenTo } = req.body;
    if (!propertyId) return res.status(400).json({ error: 'propertyId required' });
    if (!givenTo) return res.status(400).json({ error: 'givenTo required' });
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });

    // 1. Upload photo to Notion via file upload API
    let notionFileUrl = null;
    try {
      // Step 1: create file upload session
      const createRes = await fetch('https://api.notion.com/v1/files', {
        method: 'POST',
        headers: { ...notionHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: { type: 'page_id', page_id: propertyId }, name: req.file.originalname || 'key-return-photo.jpg' }),
      });
      const createData = await createRes.json();
      if (createData.upload_url) {
        // Step 2: PUT binary to the presigned URL
        await fetch(createData.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': req.file.mimetype },
          body: req.file.buffer,
        });
        // Step 3: retrieve hosted URL from file object
        if (createData.url) notionFileUrl = createData.url;
      }
    } catch (uploadErr) {
      console.warn('[remove-property] Notion file upload failed:', uploadErr.message);
    }

    // 2. Get property info
    const propPage = await fetch(`https://api.notion.com/v1/pages/${propertyId}`, { headers: notionHeaders() }).then(r => r.json());
    if (propPage.object === 'error') throw new Error(propPage.message);
    const propertyCode = extractRichText(propPage.properties?.['Property Code']) || '';

    // 3. Update property page: set Key Return Notes, Key Return Date, archive it
    const today = mtDateStr();
    const notes = `Keys returned to: ${givenTo} on ${today}`;
    const returnProps = {
      'Key Return Notes': { rich_text: [{ text: { content: notes } }] },
      'Key Return Date': { date: { start: today } },
    };
    // Attach photo as external file if we got a URL, otherwise skip files property
    if (notionFileUrl) {
      returnProps['Key Return Photo'] = { files: [{ type: 'external', external: { url: notionFileUrl }, name: req.file.originalname || 'key-return-photo.jpg' }] };
    }
    await notionPatch(`https://api.notion.com/v1/pages/${propertyId}`, { properties: returnProps });

    // 4. Append image block to property page (always — shows photo even if file property didn't work)
    // Upload as base64 data URI in an image block (Notion doesn't support data URIs, so use external only if we have URL)
    if (notionFileUrl) {
      await fetch(`https://api.notion.com/v1/blocks/${propertyId}/children`, {
        method: 'PATCH',
        headers: { ...notionHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ children: [
          { type: 'heading_3', heading_3: { rich_text: [{ text: { content: `Key Return — ${today}` } }] } },
          { type: 'paragraph', paragraph: { rich_text: [{ text: { content: `Keys handed to: ${givenTo}` } }] } },
          { type: 'image', image: { type: 'external', external: { url: notionFileUrl } } },
        ]}),
      });
    } else {
      // No hosted URL — at least log the note as a block
      await fetch(`https://api.notion.com/v1/blocks/${propertyId}/children`, {
        method: 'PATCH',
        headers: { ...notionHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ children: [
          { type: 'heading_3', heading_3: { rich_text: [{ text: { content: `Key Return — ${today}` } }] } },
          { type: 'paragraph', paragraph: { rich_text: [{ text: { content: `Keys handed to: ${givenTo}` } }] } },
          { type: 'callout', callout: { icon: { type: 'emoji', emoji: '📷' }, rich_text: [{ text: { content: 'Photo was captured but could not be uploaded to Notion automatically. Please attach manually.' } }] } },
        ]}),
      });
    }

    // 5. Find all keys linked to this property:
    //    a) by Rental Matrix relation (standard)
    //    b) by MF Unit Property Code relation — look up MF property page by Property Code first
    let mfPageId = null;
    if (propertyCode) {
      try {
        const mfRows = await queryAll(DB.mfProperties, { property: 'Property Code', title: { equals: propertyCode } });
        if (mfRows.length) mfPageId = mfRows[0].id;
      } catch (mfErr) { console.warn('[remove-property] MF lookup failed:', mfErr.message); }
    }
    const [keysByRelation, keysByMFCode] = await Promise.all([
      queryAll(DB.keys, { property: 'Rental Matrix', relation: { contains: propertyId } }),
      mfPageId ? queryAll(DB.keys, { property: 'MF Unit Property Code', relation: { contains: mfPageId } }) : Promise.resolve([]),
    ]);
    const seen = new Set();
    const keyRows = [...keysByRelation, ...keysByMFCode].filter(r => seen.has(r.id) ? false : seen.add(r.id));

    await Promise.all(keyRows.map(row =>
      notionPatch(`https://api.notion.com/v1/pages/${row.id}`, {
        properties: {
          'Rental Matrix': { relation: [] },
          'MF Unit Property Code': { relation: [] },
          'Status': { select: { name: 'In Office' } },
        },
      })
    ));

    res.json({ success: true, keysCleared: keyRows.length });
  } catch (e) {
    console.error('[remove-property] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Receive Keys ──────────────────────────────────────────────────────────────
// Accepts multipart: propertyId, photo (file)
app.post('/api/receive-keys', requireAuth, uploadMemory.single('photo'), async (req, res) => {
  try {
    const { propertyId } = req.body;
    if (!propertyId) return res.status(400).json({ error: 'propertyId required' });
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });

    // 1. Get AI description of keys in the photo
    let aiDescription = 'No description available';
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const base64 = req.file.buffer.toString('base64');
        const mime = req.file.mimetype || 'image/jpeg';
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
              { type: 'text', text: 'You are helping a property management company inventory keys they just received. Describe exactly what keys you see in this photo: how many keys, any key tag numbers visible, any labels, key types (house key, mailbox key, etc.), and any other identifying details. Be concise and specific. If you cannot see keys clearly, say so.' },
            ]}],
          }),
        });
        const claudeData = await claudeRes.json();
        aiDescription = claudeData.content?.[0]?.text || aiDescription;
      } catch (aiErr) {
        console.warn('[receive-keys] AI description failed:', aiErr.message);
      }
    }

    // 2. Get property info
    const propPage = await fetch(`https://api.notion.com/v1/pages/${propertyId}`, { headers: notionHeaders() }).then(r => r.json());
    if (propPage.object === 'error') throw new Error(propPage.message);
    const address = extractRichText(propPage.properties?.['Street Address - Property']) || 'Unknown Property';

    // 3. Upload photo to Notion
    let notionFileUrl = null;
    try {
      const createRes = await fetch('https://api.notion.com/v1/files', {
        method: 'POST',
        headers: { ...notionHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: { type: 'page_id', page_id: propertyId }, name: req.file.originalname || 'received-keys.jpg' }),
      });
      const createData = await createRes.json();
      if (createData.upload_url) {
        await fetch(createData.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': req.file.mimetype },
          body: req.file.buffer,
        });
        if (createData.url) notionFileUrl = createData.url;
      }
    } catch (uploadErr) {
      console.warn('[receive-keys] Notion file upload failed:', uploadErr.message);
    }

    // 4. Append inventory block to property page
    const today = mtDateStr();
    const children = [
      { type: 'heading_3', heading_3: { rich_text: [{ text: { content: `Keys Received — ${today}` } }] } },
      { type: 'paragraph', paragraph: { rich_text: [{ text: { content: `AI Inventory: ${aiDescription}` } }] } },
    ];
    if (notionFileUrl) {
      children.push({ type: 'image', image: { type: 'external', external: { url: notionFileUrl } } });
    } else {
      children.push({ type: 'callout', callout: { icon: { type: 'emoji', emoji: '📷' }, rich_text: [{ text: { content: 'Photo captured but could not be uploaded automatically. Please attach manually.' } }] } });
    }
    await fetch(`https://api.notion.com/v1/blocks/${propertyId}/children`, {
      method: 'PATCH',
      headers: { ...notionHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ children }),
    });

    res.json({ success: true, address, aiDescription });
  } catch (e) {
    console.error('[receive-keys] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Assign Key Tag ─────────────────────────────────────────────────────────────
// Returns keys that are In Office with no property (Rental Matrix) assigned
app.get('/api/available-key-tags', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.keys, {
      and: [
        {
          or: [
            { property: 'Status', select: { equals: 'In Office' } },
            { property: 'Status', select: { is_empty: true } },
          ],
        },
        { property: 'Rental Matrix', relation: { is_empty: true } },
        { property: 'MF Unit Property Code', relation: { is_empty: true } },
      ],
    }, [{ property: 'Key Tag #', direction: 'ascending' }]);
    const tags = rows.map(r => ({
      id: r.id,
      tag: extractRichText(r.properties?.['Key Tag #']),
      keyTypes: extractMultiSelect(r.properties?.['Key Types']),
    })).filter(t => t.tag);
    res.json(tags);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assigns a property to a key tag and records a photo
app.post('/api/assign-key-tag', requireAuth, uploadMemory.single('photo'), async (req, res) => {
  try {
    const { keyId, propertyId } = req.body;
    if (!keyId) return res.status(400).json({ error: 'keyId required' });
    if (!propertyId) return res.status(400).json({ error: 'propertyId required' });
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });

    // 1. Upload photo to Notion key page
    let notionFileUrl = null;
    try {
      const createRes = await fetch('https://api.notion.com/v1/files', {
        method: 'POST',
        headers: { ...notionHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: { type: 'page_id', page_id: keyId }, name: req.file.originalname || 'key-tag-photo.jpg' }),
      });
      const createData = await createRes.json();
      if (createData.upload_url) {
        await fetch(createData.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': req.file.mimetype },
          body: req.file.buffer,
        });
        if (createData.url) notionFileUrl = createData.url;
      }
    } catch (uploadErr) {
      console.warn('[assign-key-tag] Notion file upload failed:', uploadErr.message);
    }

    // 2. Update key: set Rental Matrix relation + photo
    const updateProps = {
      'Rental Matrix': { relation: [{ id: propertyId }] },
    };
    if (notionFileUrl) {
      updateProps['Photos of Keys at Takeover'] = { files: [{ type: 'external', external: { url: notionFileUrl }, name: req.file.originalname || 'key-tag-photo.jpg' }] };
    }
    await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, { properties: updateProps });

    // 3. Get property name for confirmation
    const propPage = await fetch(`https://api.notion.com/v1/pages/${propertyId}`, { headers: notionHeaders() }).then(r => r.json());
    const address = extractRichText(propPage.properties?.['Street Address - Property']) || 'Unknown Property';

    res.json({ success: true, address });
  } catch (e) {
    console.error('[assign-key-tag] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KRB Key App running on http://localhost:${PORT}`);
  scheduleDailyOverdueCheck();
  if (!SLACK_WEBHOOK_URL) console.warn('⚠️  SLACK_WEBHOOK_URL not set — Slack alerts disabled');
});
