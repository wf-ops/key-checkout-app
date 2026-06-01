require('dotenv').config();
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
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

// Auth middleware
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

// Photos stored in Google Drive — use memory storage (no local disk)
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
};

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

// Fetch all pages from a database with pagination
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

// --- Property helpers ---

function extractRichText(prop) {
  if (!prop) return '';
  if (prop.type === 'rich_text') return prop.rich_text.map(r => r.plain_text).join('');
  if (prop.type === 'title') return prop.title.map(r => r.plain_text).join('');
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

// POST /api/login
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

// POST /api/logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// GET /api/me
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// POST /api/change-pin — any authenticated user can change their own PIN
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

// --- Admin: User Management ---

// GET /api/users
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
    res.status(500).json({ error: e.message });
  }
});

// POST /api/users — create user
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

// PATCH /api/users/:id — update role, active, or reset PIN
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

// DELETE /api/users/:id — deactivate (not hard delete)
app.delete('/api/users/:id', requireRole('Admin'), async (req, res) => {
  try {
    await notionPatch(`https://api.notion.com/v1/pages/${req.params.id}`, { properties: { 'Active': { checkbox: false } } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard  — open checkouts (no Date Returned)
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.log, {
      property: 'Date Returned',
      date: { is_empty: true },
    });

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

// GET /api/keys-for-property/:propertyId
// Fetches the property page, reads its "Keys & Access" relation, returns those key pages
app.get('/api/keys-for-property/:propertyId', requireAuth, async (req, res) => {
  try {
    // 1. Fetch the property page to get its Keys & Access relation
    const propPage = await fetch(`https://api.notion.com/v1/pages/${req.params.propertyId}`, {
      headers: notionHeaders(),
    }).then(r => r.json());

    if (propPage.object === 'error') {
      throw new Error(propPage.message);
    }

    const keyRelation = propPage.properties?.['KRB Keys & Access']?.relation || [];
    if (keyRelation.length === 0) {
      return res.json([]);
    }

    // 2. Fetch each key page in parallel
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

// GET /api/search-properties?q=...
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
      .filter(r => {
        // Only pages that belong to the properties database
        return r.parent?.database_id?.replace(/-/g, '') === DB.properties.replace(/-/g, '');
      })
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

// POST /api/checkout
app.post('/api/checkout', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    const { keyId, keySlot, staffId, staffName, purpose, dateOut, dateDue, propertyId, propertyUrl } = req.body;
    const existingLogRelation = JSON.parse(req.body.existingLogRelation || '[]');
    const photoFile = req.file;

    const logTitle = `Key #${keySlot} - ${mtTimestamp()}`;

    // 1. Create log entry
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

    // 1b. Save checkout photo to Google Drive and store link in Notion
    if (photoFile) {
      const photoUrl = await uploadToDrive(photoFile.buffer, photoFile.originalname, photoFile.mimetype);
      await notionPatch(`https://api.notion.com/v1/pages/${logPage.id}`, {
        properties: {
          'Check-Out Photo': { files: [{ name: photoFile.originalname || 'checkout-photo.jpg', type: 'external', external: { url: photoUrl } }] },
        },
      });
    }

    // 2. Update key: Status = Checked Out, append log entry to relation
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

// POST /api/checkin
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

// GET /api/key-by-log/:logId  — find key page associated with a log entry
app.get('/api/key-by-log/:logId', requireAuth, async (req, res) => {
  try {
    const logPage = await fetch(`https://api.notion.com/v1/pages/${req.params.logId}`, {
      headers: notionHeaders(),
    }).then(r => r.json());

    // The log entry has a relation back to the key via "Key Check-In/ Check-Out Log"
    // But we need to find the key that has this log in its relation.
    // More direct: query Keys DB filtered by the log relation.
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

// GET /api/all-keys-for-property/:propertyId — all keys regardless of status
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

// POST /api/remove-key — clear property relation and mark key as unassigned
// Body: { keyId }
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

// POST /api/mark-missing  — set key Status to "Missing"
// Body: { keyId }
app.post('/api/mark-missing', requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const { keyId } = req.body;
    await notionPatch(`https://api.notion.com/v1/pages/${keyId}`, {
      properties: {
        'Status': { select: { name: 'Missing' } },
      },
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/missing-keys — all keys with Status = "Missing", with property name
app.get('/api/missing-keys', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.keys, {
      property: 'Status',
      select: { equals: 'Missing' },
    });

    const keys = await Promise.all(rows.map(async row => {
      const p = row.properties;
      const slot = extractRichText(p['Key Slot #']);
      const keyTypes = extractMultiSelect(p['Key Types']);
      const rentalUrls = extractRelation(p['Rental Matrix']);

      // Fetch property name for each related property
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

// POST /api/return-key — mark key as back In Office, accepts optional photo + note
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

    // Append note as a page block if provided
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

// GET /api/key-by-slot/:slot — find existing key record by slot number
app.get('/api/key-by-slot/:slot', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(DB.keys, {
      property: 'Key Slot #',
      title: { equals: req.params.slot },
    });
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

// POST /api/add-key
// Body: { propertyId, slot, keyTypes, existingKeyId? }
// Creates a new key record or updates the existing one (when reassigning)
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
      // Update existing record
      await notionPatch(`https://api.notion.com/v1/pages/${existingKeyId}`, { properties });
      res.json({ success: true, keyId: existingKeyId, created: false });
    } else {
      // Create new record
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

// Track which log entries we've already alerted about today to avoid repeat pings
const notifiedToday = new Set();

const MT_TZ = 'America/Boise';

function mtDateStr(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: MT_TZ }); // en-CA gives YYYY-MM-DD
}

function mtTimestamp(date = new Date()) {
  return date.toLocaleString('en-US', { timeZone: MT_TZ });
}

function clearNotifiedAtMidnight() {
  // Schedule reset at Mountain Time midnight
  const now = new Date();
  const tomorrowMT = new Date(now.toLocaleDateString('en-CA', { timeZone: MT_TZ }) + 'T00:00:00');
  tomorrowMT.setDate(tomorrowMT.getDate() + 1);
  const msMT = new Date(tomorrowMT.toLocaleString('en-US', { timeZone: MT_TZ }));
  const msUntilMidnight = tomorrowMT - now;
  setTimeout(() => {
    notifiedToday.clear();
    clearNotifiedAtMidnight();
  }, msUntilMidnight);
}
clearNotifiedAtMidnight();

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
      if (new Date(dateDue) >= new Date(today)) return false;
      const key = `${row.id}-${today}`;
      if (notifiedToday.has(key)) return false;
      notifiedToday.add(key);
      return true;
    });

    if (overdue.length === 0) return;

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

// POST /api/test-slack — manual trigger for testing
app.post('/api/test-slack', requireRole('Admin'), async (req, res) => {
  try {
    await sendSlackAlert('✅ KRB Key App Slack connection test — working!');
    res.json({ success: true, message: 'Test message sent to #maintenance-general' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KRB Key App running on http://localhost:${PORT}`);
  // Check immediately on startup, then every hour
  checkOverdueKeys();
  setInterval(checkOverdueKeys, 60 * 60 * 1000);
  if (!SLACK_WEBHOOK_URL) console.warn('⚠️  SLACK_WEBHOOK_URL not set — Slack alerts disabled');
});
