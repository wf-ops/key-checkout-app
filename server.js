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
app.use(express.json());
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
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive.file'] });
  const drive = google.drive({ version: 'v3', auth });
  const ext = path.extname(originalname) || '.jpg';
  const filename = `key-photo-${Date.now()}${ext}`;
  const file = await drive.files.create({
    requestBody: { name: filename, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: mimetype || 'image/jpeg', body: Readable.from(buffer) },
    fields: 'id,webViewLink',
  });
  await drive.permissions.create({ fileId: file.data.id, requestBody: { role: 'reader', type: 'anyone' } });
  return file.data.webViewLink;
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';

const DB = {
  keys: 'bb222b13-e089-42ec-9458-9f1800c06bd8',
  log: '6493156c-9348-45a5-9632-0552edda23b5',
  properties: '2d161a46-cdef-80a8-aae1-cf5bb3f0fb0b',
  staff: '32243e9b-6fd7-407e-8baf-55bfa320408d',
  lockboxes: '30a61a46-cdef-80c1-a015-000b55945cbe',
  kwiksetCuts: '30a61a46-cdef-80b1-aa2b-e6cb42560512',
};

const CODEBOX_BASE = 'https://api02.codeboxinc.com';
let codeboxToken = null;
let codeboxTokenExp = 0;

async function getCodeboxToken() {
  if (codeboxToken && Date.now() < codeboxTokenExp - 60000) return codeboxToken;
  const res = await fetch(`${CODEBOX_BASE}/authentication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: process.env.CODEBOX_USERNAME, Password: process.env.CODEBOX_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Codebox auth failed: ${res.status}`);
  const token = await res.text();
  const clean = token.replace(/^"|"$/g, '');
  const payload = JSON.parse(Buffer.from(clean.split('.')[1], 'base64').toString());
  codeboxToken = clean;
  codeboxTokenExp = payload.exp * 1000;
  return codeboxToken;
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
    const rows = await queryAll(DB.staff, null);
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

// GET /api/properties
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

// GET /api/search-properties?q=
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

// GET /api/keys
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

// GET /api/log
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

// GET /api/missing-keys — all log entries with no Date Returned
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
      return { id: row.id, keyTag, staffName, dateOut, daysOut, propertyName };
    }));
    res.json(entries.filter(e => e.keyTag || e.propertyName));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /api/staff
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

// GET /api/lockbox-code/:id
app.get('/api/lockbox-code/:id', requireAuth, async (req, res) => {
  try {
    const lockboxPage = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: notionHeaders() }).then(r => r.json());
    if (lockboxPage.object === 'error') return res.status(404).json({ error: 'Lockbox not found' });
    const sn = extractRichText(lockboxPage.properties?.['Lockbox SN']);
    if (!sn) return res.status(404).json({ error: 'Lockbox serial number not found' });
    if (!process.env.CODEBOX_USERNAME || !process.env.CODEBOX_PASSWORD) return res.status(503).json({ error: 'Codebox credentials not configured' });
    const token = await getCodeboxToken();
    const today = mtDateStr();
    const cbRes = await fetch(`${CODEBOX_BASE}/showing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
      body: JSON.stringify({ SerialNumber: parseInt(sn), DateOfShowing: today }),
    });
    const data = await cbRes.json();
    if (!cbRes.ok) return res.status(cbRes.status).json({ error: data?.Message || 'Codebox error' });
    res.json({ code: data.Code || data.code || String(data) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /api/kwikset-options — list all Kwikset Cut options
// Title field in Kwikset Cuts DB is "Kwikset Key #"
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

// Fields editable via PATCH /api/property-codes — all stored as rich_text to preserve leading zeros
const PROPERTY_CODE_FIELDS = {
  frontDoorCode: 'Front Door Code',
  garageKeypad: 'Garage Keypad',
  communityEntryCode: 'Community Entry Code',
};

// GET /api/property-codes/:propertyId
app.get('/api/property-codes/:propertyId', requireAuth, async (req, res) => {
  try {
    const [propPage, keyRows] = await Promise.all([
      fetch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, { headers: notionHeaders() }).then(r => r.json()),
      queryAll(DB.keys, { property: 'Rental Matrix', relation: { contains: req.params.propertyId } }),
    ]);
    if (propPage.object === 'error') throw new Error(propPage.message);
    const p = propPage.properties;

    // Kwikset Cut is a relation on Property Matrix — fetch the title of the linked page
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

    // Keys: only tag, status, types — code fields moved to Property Matrix
    const keys = keyRows.map(row => {
      const kp = row.properties;
      return {
        id: row.id,
        tag: extractRichText(kp['Key Tag #']),
        status: extractSelect(kp['Status']),
        keyTypes: extractMultiSelect(kp['Key Types']),
      };
    });

    res.json({
      address: extractRichText(p['Street Address - Property']),
      propertyCode: extractRichText(p['Property Code']),
      frontDoorCode: extractRichText(p['Front Door Code']),
      garageKeypad: extractRichText(p['Garage Keypad']),
      communityEntryCode: extractRichText(p['Community Entry Code']),
      kwiksetCut,
      kwiksetCutId,
      keys,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// PATCH /api/property-codes/:propertyId
app.patch('/api/property-codes/:propertyId', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { field, value } = req.body;
    const notionField = PROPERTY_CODE_FIELDS[field];
    if (!notionField) return res.status(400).json({ error: 'Unknown field: ' + field });
    // Store as rich_text to preserve leading zeros
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, {
      properties: { [notionField]: { rich_text: [{ text: { content: value || '' } }] } },
    });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// PATCH /api/property-kwikset/:propertyId
// Updates Kwikset Cut relation and appends old value to Previous Kwiksets relation
app.patch('/api/property-kwikset/:propertyId', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { kwiksetPageId, previousKwiksetId } = req.body;
    const props = {
      'Kwikset Cut': { relation: kwiksetPageId ? [{ id: kwiksetPageId }] : [] },
    };
    // Append previous kwikset to the Previous Kwiksets relation (avoid duplicates)
    if (previousKwiksetId) {
      const propPage = await fetch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, { headers: notionHeaders() }).then(r => r.json());
      const existing = propPage.properties?.['Previous Kwiksets']?.relation || [];
      const alreadyPresent = existing.some(r => r.id === previousKwiksetId);
      if (!alreadyPresent) {
        props['Previous Kwiksets'] = { relation: [...existing, { id: previousKwiksetId }] };
      }
    }
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, { properties: props });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /api/checkout
app.post('/api/checkout', requireAuth, async (req, res) => {
  try {
    const { keyId, staffId, propertyId } = req.body;
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
    const logPage = await notionPost('https://api.notion.com/v1/pages', { parent: { database_id: DB.log }, properties: logProps });
    await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, {
      properties: {
        'Status': { select: { name: 'Checked Out' } },
        'Key Check-In/ Check-Out Log': { relation: [...existingLogRelation, { id: logPage.id }] },
      },
    });
    res.json({ success: true, logId: logPage.id });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /api/checkin
app.post('/api/checkin', requireAuth, async (req, res) => {
  try {
    const { keyId } = req.body;
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
    const updates = [notionPatch(`https://api.notion.com/v1/pages/${keyId}`, { properties: { 'Status': { select: { name: 'In Office' } } } })];
    if (activeLogId) updates.push(notionPatch(`https://api.notion.com/v1/pages/${activeLogId}`, { properties: { 'Date Returned': { date: { start: mtDateStr() } } } }));
    await Promise.all(updates);
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

// Lockboxes
app.get('/api/lockboxes', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.lockboxes, null, [{ property: 'Lockbox SN', direction: 'ascending' }]);
    const boxes = rows.map(r => {
      const p = r.properties;
      const propRel = p['Last Known Property']?.relation || [];
      return { id: r.id, sn: extractRichText(p['Lockbox SN']), krbBox: p['KRB Key Box #']?.number || null, status: p['Status']?.select?.name || 'Unassigned', propertyId: propRel[0]?.id || null, propertyName: extractRichText(p['Merge']) || null, notes: extractRichText(p['Notes']) };
    }).filter(b => b.sn);
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
    const cbRes = await fetch(`${CODEBOX_BASE}/showing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
      body: JSON.stringify({ SerialNumber: parseInt(serialNumber), DateOfShowing: date }),
    });
    const data = await cbRes.json();
    if (!cbRes.ok) return res.status(cbRes.status).json({ error: data?.Message || 'Codebox error' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KRB Key App running on http://localhost:${PORT}`);
  scheduleDailyOverdueCheck();
  if (!SLACK_WEBHOOK_URL) console.warn('⚠️  SLACK_WEBHOOK_URL not set — Slack alerts disabled');
});
