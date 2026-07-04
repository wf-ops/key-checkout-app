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
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
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
  const res = await fetch(url, {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }
  return res.json();
}

async function notionPatch(url, body) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: notionHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }
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

function extractRelation(prop) {
  if (!prop || prop.type !== 'relation') return [];
  return prop.relation.map(r => `https://www.notion.so/${r.id.replace(/-/g, '')}`);
}

function extractDate(prop, field) {
  if (!prop || prop.type !== 'date') return null;
  return prop.date?.[field] || null;
}

function extractPeople(prop) {
  if (!prop || prop.type !== 'people') return [];
  return prop.people.map(p => p.id);
}

// --- API Routes ---

app.post('/api/login', async (req, res) => {
  try {
    const { username, pin } = req.body;
    if (!username || !pin) return res.status(400).json({ error: 'Username and PIN required' });
    const rows = await queryAll(DB.staff, { property: 'Username', rich_text: { equals: username.toLowerCase().trim() } });
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid username or PIN' });
    const user = rows[0];
    const active = user.properties['Active']?.checkbox;
    if (!active) return res.status(401).json({ error: 'Account is inactive' });
    const hash = user.properties['PIN Hash']?.rich_text?.[0]?.plain_text || '';
    const valid = await bcrypt.compare(pin, hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or PIN' });
    req.session.user = {
      id: user.id,
      name: user.properties['Name']?.title?.[0]?.plain_text || username,
      username: username.toLowerCase().trim(),
      role: user.properties['Role']?.select?.name || 'Member',
      notionPersonId: user.properties['Notion Person ID']?.rich_text?.[0]?.plain_text || '',
    };
    res.json({ success: true, user: req.session.user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

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
    const valid = await bcrypt.compare(currentPin, hash);
    if (!valid) return res.status(401).json({ error: 'Current PIN is incorrect' });
    const newHash = await bcrypt.hash(newPin, 10);
    await notionPatch(`https://api.notion.com/v1/pages/${user.id}`, { properties: { 'PIN Hash': { rich_text: [{ text: { content: newHash } }] } } });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user-list', async (req, res) => {
  try {
    const rows = await queryAll(DB.staff, { property: 'Active', checkbox: { equals: true } });
    const users = rows.map(r => ({
      username: extractRichText(r.properties['Username']),
      name: extractRichText(r.properties['Name']),
    })).filter(u => u.username);
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ error: e.message });  }
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', requireRole('Admin'), async (req, res) => {
  try {
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.id}`, { properties: { 'Active': { checkbox: false } } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.log, { property: 'Date Returned', date: { is_empty: true } });
    const entries = rows
      .map(row => {
        const p = row.properties;
        return {
          id: row.id,
          url: row.url,
          logEntry: extractRichText(p['Log Entry']),
          checkedOutBy: extractPeople(p['Checked Out By']),
          dateOut: extractDate(p['Date Out'], 'start'),
          dateDue: extractDate(p['Date Out'], 'end'),
          dateReturned: extractDate(p['Date Returned'], 'start'),
          purpose: extractSelect(p['Purpose']),
          property: extractRelation(p['Property']),
          keyRelation: extractRelation(p['Key Check-In/ Check-Out Log']),
        };
      })
      .filter(e => e.logEntry && e.dateOut);
    res.json(entries);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/keys-for-property/:propertyId', requireAuth, async (req, res) => {
  try {
    const propPage = await fetch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, {
      headers: notionHeaders(),
    }).then(r => r.json());
    if (propPage.object === 'error') throw new Error(propPage.message);
    const keyRelation = propPage.properties?.['KRB Keys & Access']?.relation || [];
    if (keyRelation.length === 0) return res.json([]);
    const keyPages = await Promise.all(
      keyRelation.map(r =>
        fetch(`https://api.notion.com/v1/pages/${r.id}`, { headers: notionHeaders() }).then(x => x.json())
      )
    );
    const keys = keyPages
      .filter(row => row.object !== 'error')
      .map(row => {
        const p = row.properties;
        return {
          id: row.id,
          url: row.url,
          slot: extractRichText(p['Key Slot #']),
          kwiksetCut: extractRichText(p['Kwikset Cut']),
          status: extractSelect(p['Status']),
          keyTypes: extractMultiSelect(p['Key Types']),
          logRelation: extractRelation(p['Key Check-In/ Check-Out Log']),
        };
      })
      .filter(k => !k.status || k.status === 'In Office');
    res.json(keys);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search-properties', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const data = await notionPost('https://api.notion.com/v1/search', {
      query: q,
      filter: { value: 'page', property: 'object' },
      page_size: 20,
    });
    const results = data.results
      .filter(r => r.parent?.database_id?.replace(/-/g, '') === DB.properties.replace(/-/g, ''))
      .map(r => {
        const p = r.properties;
        return {
          id: r.id,
          url: r.url,
          propertyCode: extractRichText(p['Property Code']),
          address: extractRichText(p['Street Address - Property']),
          city: extractRichText(p['City']),
          state: extractRichText(p['State - Property']),
        };
      });
    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PROPERTY_CODE_FIELDS = {
  frontDoorCode: 'Front Door Code',
  garageKeypad: 'Garage Keypad',
  communityEntryCode: 'Community Entry Code',
  mailboxNumber: 'Mailbox #',
  mailboxLocation: 'Mailbox Location',
  otherSystems: 'Other Property Systems',
  maintenanceNotes: 'Maintenance Notes',
};

// GET /api/property-codes/:propertyId
app.get('/api/property-codes/:propertyId', requireAuth, async (req, res) => {
  try {
    const [propPage, keyRows] = await Promise.all([
      fetch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, {
        headers: notionHeaders(),
      }).then(r => r.json()),
      queryAll(DB.keys, {
        property: 'Rental Matrix',
        relation: { contains: req.params.propertyId },
      }),
    ]);
    if (propPage.object === 'error') throw new Error(propPage.message);
    const p = propPage.properties;
    const keys = keyRows.map(row => {
      const kp = row.properties;
      return {
        id: row.id,
        slot: extractRichText(kp['Key Slot #']),
        kwiksetCut: extractRichText(kp['Kwikset Cut']),
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
      mailboxNumber: extractRichText(p['Mailbox #']) || (p['Mailbox #']?.number != null ? String(p['Mailbox #'].number) : ''),
      mailboxLocation: extractRichText(p['Mailbox Location']),
      otherSystems: extractRichText(p['Other Property Systems']),
      maintenanceNotes: extractRichText(p['Maintenance Notes']),
      keys,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/property-codes/:propertyId — update a single property field
app.patch('/api/property-codes/:propertyId', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { field, value } = req.body;
    const notionField = PROPERTY_CODE_FIELDS[field];
    if (!notionField) return res.status(400).json({ error: 'Unknown field: ' + field });
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, {
      properties: { [notionField]: { rich_text: [{ text: { content: value || '' } }] } },
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/keys/:keyId — update key fields (kwikset cut)
app.patch('/api/keys/:keyId', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { kwiksetCut } = req.body;
    const props = {};
    if (kwiksetCut !== undefined) props['Kwikset Cut'] = { rich_text: [{ text: { content: kwiksetCut || '' } }] };
    if (Object.keys(props).length === 0) return res.status(400).json({ error: 'No valid fields provided' });
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.keyId}`, { properties: props });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkout', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    const { keyId, keySlot, staffId, staffName, purpose, dateOut, dateDue, propertyId, propertyUrl } = req.body;
    const existingLogRelation = JSON.parse(req.body.existingLogRelation || '[]');
    const photoFile = req.file;
    const logTitle = `Key #${keySlot} - ${mtTimestamp()}`;
    const logPage = await notionPost('https://api.notion.com/v1/pages', {
      parent: { database_id: DB.log },
      properties: {
        'Log Entry': { title: [{ text: { content: logTitle } }] },
        'Checked Out By': { people: [{ id: staffId }] },
        'Date Out': { date: { start: dateOut, end: dateDue } },
        'Purpose': { select: { name: purpose } },
        'Property': { relation: [{ id: propertyId }] },
      },
    });
    if (photoFile) {
      const photoUrl = await uploadToDrive(photoFile.buffer, photoFile.originalname, photoFile.mimetype);
      await notionPatch(`https://api.notion.com/v1/pages/${logPage.id}`, {
        properties: {
          'Check-Out Photo': { files: [{ name: photoFile.originalname || 'checkout-photo.jpg', type: 'external', external: { url: photoUrl } }] },
        },
      });
    }
    const updatedLogRelation = [...(existingLogRelation || []).map(url => {
      const id = url.split('/').pop().replace(/[^a-f0-9]/gi, '');
      return { id: `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}` };
    }), { id: logPage.id }];
    await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, {
      properties: {
        'Status': { select: { name: 'Checked Out' } },
        'Key Check-In/ Check-Out Log': { relation: updatedLogRelation },
      },
    });
    res.json({ success: true, logId: logPage.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkin', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    const { logId, keyId } = req.body;
    const photoFile = req.file;
    const today = mtDateStr();
    const logProps = { 'Date Returned': { date: { start: today } } };
    if (photoFile) {
      const photoUrl = await uploadToDrive(photoFile.buffer, photoFile.originalname, photoFile.mimetype);
      logProps['Check-In Photo'] = { files: [{ name: photoFile.originalname || 'checkin-photo.jpg', type: 'external', external: { url: photoUrl } }] };
    }
    await Promise.all([
      notionPatch(`https://api.notion.com/v1/pages/${logId}`, { properties: logProps }),
      notionPatch(`https://api.notion.com/v1/pages/${keyId}`, { properties: { 'Status': { select: { name: 'In Office' } } } }),
    ]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/key-by-log/:logId', requireAuth, async (req, res) => {
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.logId}`, { headers: notionHeaders() }).then(r => r.json());
    const rows = await queryAll(DB.keys, {
      property: 'Key Check-In/ Check-Out Log',
      relation: { contains: req.params.logId },
    });
    if (rows.length === 0) return res.status(404).json({ error: 'Key not found for log entry' });
    res.json({ keyId: rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/all-keys-for-property/:propertyId', requireAuth, async (req, res) => {
  try {
    const propPage = await fetch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, {
      headers: notionHeaders(),
    }).then(r => r.json());
    if (propPage.object === 'error') throw new Error(propPage.message);
    const keyRelation = propPage.properties?.['KRB Keys & Access']?.relation || [];
    if (keyRelation.length === 0) return res.json([]);
    const keyPages = await Promise.all(
      keyRelation.map(r =>
        fetch(`https://api.notion.com/v1/pages/${r.id}`, { headers: notionHeaders() }).then(x => x.json())
      )
    );
    const keys = keyPages
      .filter(row => row.object !== 'error')
      .map(row => {
        const p = row.properties;
        return {
          id: row.id,
          slot: extractRichText(p['Key Slot #']),
          kwiksetCut: extractRichText(p['Kwikset Cut']),
          status: extractSelect(p['Status']),
          keyTypes: extractMultiSelect(p['Key Types']),
          logRelation: extractRelation(p['Key Check-In/ Check-Out Log']),
        };
      });
    res.json(keys);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/remove-key', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { keyId } = req.body;
    await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, {
      properties: {
        'Rental Matrix': { relation: [] },
        'Status': { select: { name: 'In Office' } },
      },
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mark-missing', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { keyId } = req.body;
    await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, {
      properties: { 'Status': { select: { name: 'Missing' } } },
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/missing-keys', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.keys, { property: 'Status', select: { equals: 'Missing' } });
    const keys = await Promise.all(rows.map(async row => {
      const p = row.properties;
      const slot = extractRichText(p['Key Slot #']);
      const keyTypes = extractMultiSelect(p['Key Types']);
      const rentalUrls = extractRelation(p['Rental Matrix']);
      let propertyName = '';
      if (rentalUrls.length > 0) {
        try {
          const propId = rentalUrls[0].split('/').pop();
          const propPage = await fetch(`https://api.notion.com/v1/pages/${propId}`, {
            headers: notionHeaders(),
          }).then(r => r.json());
          propertyName = extractRichText(propPage.properties?.['Street Address - Property']) ||
                         extractRichText(propPage.properties?.['Property Code']) || '';
        } catch (_) {}
      }
      return { id: row.id, slot, keyTypes, propertyName };
    }));
    res.json(keys);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/return-key', requireRole('Admin', 'Manager'), upload.single('photo'), async (req, res) => {
  try {
    const { keyId, note } = req.body;
    const photoFile = req.file;
    const keyProps = { 'Status': { select: { name: 'In Office' } } };
    if (photoFile) {
      const photoUrl = await uploadToDrive(photoFile.buffer, photoFile.originalname, photoFile.mimetype);
      keyProps['Return Photo'] = { files: [{ name: photoFile.originalname || 'return-photo.jpg', type: 'external', external: { url: photoUrl } }] };
    }
    await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, { properties: keyProps });
    if (note) {
      const timestamp = mtTimestamp();
      await fetch(`https://api.notion.com/v1/blocks/${keyId}/children`, {
        method: 'PATCH',
        headers: notionHeaders(),
        body: JSON.stringify({ children: [
          { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: `Key Returned — ${timestamp}` } }] } },
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: note } }] } },
        ]}),
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/key-by-slot/:slot', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.keys, { property: 'Key Slot #', title: { equals: req.params.slot } });
    if (rows.length === 0) return res.json(null);
    const row = rows[0];
    const p = row.properties;
    const rentalUrls = extractRelation(p['Rental Matrix']);
    let propertyName = '';
    if (rentalUrls.length > 0) {
      try {
        const propId = rentalUrls[0].split('/').pop();
        const propPage = await fetch(`https://api.notion.com/v1/pages/${propId}`, {
          headers: notionHeaders(),
        }).then(r => r.json());
        propertyName = extractRichText(propPage.properties?.['Street Address - Property']) ||
                       extractRichText(propPage.properties?.['Property Code']) || '';
      } catch (_) {}
    }
    res.json({
      id: row.id,
      slot: extractRichText(p['Key Slot #']),
      kwiksetCut: extractRichText(p['Kwikset Cut']),
      status: extractSelect(p['Status']),
      keyTypes: extractMultiSelect(p['Key Types']),
      propertyName,
      rentalUrls,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/add-key', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { propertyId, slot, keyTypes, existingKeyId } = req.body;
    const properties = {
      'Key Slot #': { title: [{ text: { content: String(slot) } }] },
      'Status': { select: { name: 'In Office' } },
      'Key Types': { multi_select: keyTypes.map(name => ({ name })) },
      'Rental Matrix': { relation: [{ id: propertyId }] },
    };
    if (existingKeyId) {
      await notionPatch(`https://api.notion.com/v1/pages/${existingKeyId}`, { properties });
      res.json({ success: true, keyId: existingKeyId, created: false });
    } else {
      const page = await notionPost('https://api.notion.com/v1/pages', {
        parent: { database_id: DB.keys },
        properties,
      });
      res.json({ success: true, keyId: page.id, created: true });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const MT_TZ = 'America/Boise';

function mtDateStr(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: MT_TZ });
}

function mtTimestamp(date = new Date()) {
  return date.toLocaleString('en-US', { timeZone: MT_TZ });
}

async function sendSlackAlert(message) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (e) {
    console.error('Slack alert failed:', e.message);
  }
}

async function checkOverdueKeys() {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const today = mtDateStr();
    const rows = await queryAll(DB.log, {
      and: [
        { property: 'Date Returned', date: { is_empty: true } },
        { property: 'Date Out', date: { before: today } },
      ],
    });
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
      const purpose = p['Purpose']?.select?.name || '';
      const title = p['Log Entry']?.title?.map(t => t.plain_text).join('') || 'Unknown key';
      return `• *${title}* — checked out by ${who} | Purpose: ${purpose} | Due: ${dateDue} *(${daysLate} day${daysLate !== 1 ? 's' : ''} overdue)*`;
    });
    const msg = `🔑 *KRB Overdue Key Alert* — ${overdue.length} key${overdue.length !== 1 ? 's' : ''} past due:\n${lines.join('\n')}`;
    await sendSlackAlert(msg);
    console.log(`Slack: sent overdue alert for ${overdue.length} key(s)`);
  } catch (e) {
    console.error('checkOverdueKeys error:', e.message);
  }
}

function scheduleDailyOverdueCheck() {
  const now = new Date();
  const mtParts = new Intl.DateTimeFormat('en-US', {
    timeZone: MT_TZ, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const mtHour = parseInt(mtParts.find(p => p.type === 'hour').value);
  const mtMin  = parseInt(mtParts.find(p => p.type === 'minute').value);
  let secsUntil;
  if (mtHour < 8) {
    secsUntil = (8 - mtHour) * 3600 - mtMin * 60;
  } else {
    secsUntil = (24 - mtHour + 8) * 3600 - mtMin * 60;
  }
  console.log(`Daily overdue check scheduled in ${Math.round(secsUntil / 60)} min (next 8 AM MT)`);
  setTimeout(async () => {
    await checkOverdueKeys().catch(e => console.error('Daily overdue check failed:', e.message));
    scheduleDailyOverdueCheck();
  }, secsUntil * 1000);
}

app.post('/api/test-slack', requireRole('Admin'), async (req, res) => {
  try {
    await sendSlackAlert('✅ KRB Key App Slack connection test — working!');
    res.json({ success: true, message: 'Test message sent to #maintenance-general' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Lockboxes ──────────────────────────────────────────────────────────────

app.get('/api/lockboxes', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.lockboxes, null, [{ property: 'Lockbox SN', direction: 'ascending' }]);
    const boxes = rows.map(r => {
      const p = r.properties;
      const propRel = p['Last Known Property']?.relation || [];
      return {
        id: r.id,
        sn: extractRichText(p['Lockbox SN']),
        krbBox: p['KRB Key Box #']?.number || null,
        status: p['Status']?.select?.name || 'Unassigned',
        propertyId: propRel[0]?.id || null,
        propertyName: extractRichText(p['Merge']) || null,
        notes: extractRichText(p['Notes']),
      };
    }).filter(b => b.sn);
    res.json(boxes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/lockboxes/:id', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { status, propertyId } = req.body;
    const props = {};
    if (status) props['Status'] = { select: { name: status } };
    if (propertyId !== undefined) {
      props['Last Known Property'] = propertyId
        ? { relation: [{ id: propertyId }] }
        : { relation: [] };
    }
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.id}`, { properties: props });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/lockboxes/generate-code', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { serialNumber, date } = req.body;
    if (!serialNumber || !date) return res.status(400).json({ error: 'serialNumber and date required' });
    if (!process.env.CODEBOX_USERNAME || !process.env.CODEBOX_PASSWORD) {
      return res.status(503).json({ error: 'Codebox credentials not configured' });
    }
    const token = await getCodeboxToken();
    const cbRes = await fetch(`${CODEBOX_BASE}/showing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
      body: JSON.stringify({ SerialNumber: parseInt(serialNumber), DateOfShowing: date }),
    });
    const data = await cbRes.json();
    if (!cbRes.ok) return res.status(cbRes.status).json({ error: data?.Message || 'Codebox error' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KRB Key App running on http://localhost:${PORT}`);
  scheduleDailyOverdueCheck();
  if (!SLACK_WEBHOOK_URL) console.warn('⚠️  SLACK_WEBHOOK_URL not set — Slack alerts disabled');
});
