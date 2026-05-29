const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';

const DB = {
  keys: 'b470ba9c-f1d3-4e46-aaa1-c167ddcbf694',
  log: 'a5ffe8e4-0648-4428-b761-bf3b043f54ca',
  properties: '2d161a46-cdef-8091-8d45-000b1071d25b',
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

// GET /api/dashboard  — open checkouts (no Date Returned)
app.get('/api/dashboard', async (req, res) => {
  try {
    const rows = await queryAll(DB.log, {
      property: 'Date Returned',
      date: { is_empty: true },
    });

    const entries = rows.map(row => {
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
    });

    res.json(entries);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/keys  — all keys (for filtering by property)
app.get('/api/keys', async (req, res) => {
  try {
    const rows = await queryAll(DB.keys);
    const keys = rows.map(row => {
      const p = row.properties;
      return {
        id: row.id,
        url: row.url,
        slot: extractRichText(p['Key Slot #']),
        status: extractSelect(p['Status']),
        keyTypes: extractMultiSelect(p['Key Types']),
        rentalMatrix: extractRelation(p['Rental Matrix']),
        logRelation: extractRelation(p['Key Check-In/ Check-Out Log']),
      };
    });
    res.json(keys);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/search-properties?q=...
app.get('/api/search-properties', async (req, res) => {
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
// Body: { keyId, keyUrl, keySlot, staffId, staffName, purpose, dateOut, dateDue, propertyId, propertyUrl, existingLogRelation }
app.post('/api/checkout', async (req, res) => {
  try {
    const { keyId, keyUrl, keySlot, staffId, staffName, purpose, dateOut, dateDue, propertyId, propertyUrl, existingLogRelation } = req.body;

    const logTitle = `Key ${keySlot} - ${staffName} - ${purpose}`;

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
// Body: { logId, keyId }
app.post('/api/checkin', async (req, res) => {
  try {
    const { logId, keyId } = req.body;
    const today = new Date().toISOString().slice(0, 10);

    await Promise.all([
      notionPatch(`https://api.notion.com/v1/pages/${logId}`, {
        properties: {
          'Date Returned': { date: { start: today } },
        },
      }),
      notionPatch(`https://api.notion.com/v1/pages/${keyId}`, {
        properties: {
          'Status': { select: { name: 'In Office' } },
        },
      }),
    ]);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/key-by-log/:logId  — find key page associated with a log entry
app.get('/api/key-by-log/:logId', async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KRB Key App running on http://localhost:${PORT}`));
