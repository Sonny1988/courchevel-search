/**
 * Vercel Serverless Function — /api/search
 * Queries Airtable (properties + pricing) and Cimalpes (photos)
 *
 * Required env vars:
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID   (default: app1gxPAbJp8AzH3i)
 *   CIMALPES_LOGIN
 *   CIMALPES_PASS
 */

const https = require('https');

const AT_KEY  = process.env.AIRTABLE_API_KEY;
const AT_BASE = process.env.AIRTABLE_BASE_ID || 'app1gxPAbJp8AzH3i';
const CI_LOGIN = process.env.CIMALPES_LOGIN;
const CI_PASS  = process.env.CIMALPES_PASS;
const CI_BASE  = 'https://cimalpes.com/fr/flux/';

const TABLES = {
  Properties: 'tblnbjvrihjbiQJGq',
  Pricing:    'tblxGNHlB5weTsJ81',
};

const LOC_LABELS = {
  'courchevel-1850': 'Courchevel 1850',
  'courchevel-1650': 'Courchevel 1650',
  'courchevel-1550': 'Courchevel 1550',
  'la-tania':        'La Tania',
  'le-praz':         'Le Praz',
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

// ── Airtable ──────────────────────────────────────────────────────────────────
function buildQS(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      v.forEach(item => parts.push(`${encodeURIComponent(k + '[]')}=${encodeURIComponent(item)}`));
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join('&');
}

async function atFetch(tableId, params) {
  const url = `https://api.airtable.com/v0/${AT_BASE}/${tableId}?${buildQS(params)}`;
  const raw = await httpGet(url, { Authorization: `Bearer ${AT_KEY}` });
  return JSON.parse(raw);
}

async function atPaginate(tableId, params) {
  const records = [];
  let offset = null;
  do {
    const res = await atFetch(tableId, { ...params, ...(offset ? { offset } : {}) });
    if (res.error) throw new Error(`Airtable: ${JSON.stringify(res.error)}`);
    records.push(...(res.records || []));
    offset = res.offset || null;
  } while (offset);
  return records;
}

// ── Cimalpes photo extraction ─────────────────────────────────────────────────
function extractPhotos(xml) {
  // Match any URL on admin.cimalpes.com/photos/bien/
  const pat = /https:\/\/admin\.cimalpes\.com\/photos\/bien\/\d+\/[^\s"'<>\]\[]+/g;
  const found = [];
  let m;
  while ((m = pat.exec(xml)) !== null) {
    if (!found.includes(m[0])) found.push(m[0]);
  }
  return found.slice(0, 6);
}

async function getCimalepesPhotos(cimalpes_id) {
  if (!cimalpes_id || !CI_LOGIN || !CI_PASS) return [];
  try {
    const url = `${CI_BASE}?fonction=infos&login=${encodeURIComponent(CI_LOGIN)}&pass=${encodeURIComponent(CI_PASS)}&id_bien=${cimalpes_id}`;
    const xml = await Promise.race([
      httpGet(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    return extractPhotos(xml);
  } catch {
    return [];
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const { location, checkin, guests, budget_min, budget_max, features, type } = req.query;

  try {
    // ── Build Properties filter ───────────────────────────────────────────
    const pf = ["{status}='active'"];
    if (location && location !== 'any') pf.push(`{location}='${location}'`);
    if (guests   && parseInt(guests) > 0) pf.push(`{capacity}>=${parseInt(guests)}`);
    if (type     && type !== 'any')       pf.push(`{type}='${type}'`);

    const featList = features ? features.split(',').filter(Boolean) : [];
    for (const f of featList) {
      // Escape single quotes in feature value just in case
      pf.push(`FIND('${f.replace(/'/g,"\\'")}',ARRAYJOIN({features},','))>0`);
    }

    const propFormula = pf.length > 1 ? `AND(${pf.join(',')})` : pf[0] || '1';

    // ── Build Pricing filter ──────────────────────────────────────────────
    const prF = ["{status}='available'"];
    if (checkin)    prF.push(`{checkin}='${checkin}'`);
    if (budget_min && parseInt(budget_min) > 0) prF.push(`{weekly_price}>=${parseInt(budget_min)}`);
    if (budget_max && parseInt(budget_max) > 0) prF.push(`{weekly_price}<=${parseInt(budget_max)}`);

    const pricingFormula = `AND(${prF.join(',')})`;

    // ── Fetch Airtable in parallel ────────────────────────────────────────
    const [propRecords, pricingRecords] = await Promise.all([
      atPaginate(TABLES.Properties, {
        filterByFormula: propFormula,
        fields: ['name', 'type', 'location', 'bedrooms', 'bathrooms', 'capacity',
                 'features', 'cimalpes_id', 'description_en'],
        maxRecords: 100,
      }),
      checkin
        ? atPaginate(TABLES.Pricing, {
            filterByFormula: pricingFormula,
            fields: ['property', 'checkin', 'checkout', 'weekly_price', 'currency'],
            maxRecords: 300,
          })
        : Promise.resolve([]),
    ]);

    // ── Build pricing map: propertyId → pricing ───────────────────────────
    const pricingMap = {};
    for (const r of pricingRecords) {
      for (const pid of (r.fields.property || [])) {
        if (!pricingMap[pid]) {
          pricingMap[pid] = {
            checkin:      r.fields.checkin,
            checkout:     r.fields.checkout,
            weekly_price: r.fields.weekly_price,
            currency:     r.fields.currency || 'EUR',
          };
        }
      }
    }

    // ── Sort: properties with confirmed pricing first, then others ────────
    let results = propRecords;

    results.sort((a, b) => {
      const pa = pricingMap[a.id], pb = pricingMap[b.id];
      if (pa && pb) return pa.weekly_price - pb.weekly_price;
      if (pa) return -1;
      if (pb) return 1;
      return (a.fields.name || '').localeCompare(b.fields.name || '');
    });

    results = results.slice(0, 20);

    // ── Fetch photos via Cimalpes API ─────────────────────────────────────
    const photoPromises = results.map(r =>
      r.fields.cimalpes_id ? getCimalepesPhotos(r.fields.cimalpes_id) : Promise.resolve([])
    );

    const allPhotos = await Promise.all(photoPromises);

    // ── Build response ────────────────────────────────────────────────────
    const properties = results.map((r, i) => {
      const f = r.fields;
      return {
        id:            r.id,
        name:          f.name || 'Property',
        type:          f.type || 'chalet',
        location:      f.location || '',
        locationLabel: LOC_LABELS[f.location] || f.location || '',
        bedrooms:      f.bedrooms  || 0,
        bathrooms:     f.bathrooms || 0,
        capacity:      f.capacity  || 0,
        features:      f.features  || [],
        description:   f.description_en || '',
        cimalpes_id:   f.cimalpes_id || null,
        photos:        allPhotos[i] || [],
        pricing:       pricingMap[r.id] || null,
      };
    });

    return res.status(200).json({ properties, total: properties.length });

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message || 'Search failed. Please try again.' });
  }
};
