/**
 * Vercel Serverless Function — /api/search
 *
 * Photos  → Airtable photo_url field (primary, populated by /api/sync-photos)
 *            Cimalpes ?fonction=biens (fallback, live feed)
 * Pricing → Cimalpes ?fonction=infos (always live, never Airtable)
 * Props   → Airtable Properties table (metadata only)
 */

const https = require('https');

const AT_KEY   = process.env.AIRTABLE_API_KEY;
const AT_BASE  = process.env.AIRTABLE_BASE_ID || 'app1gxPAbJp8AzH3i';
const CI_LOGIN = process.env.CIMALPES_LOGIN;
const CI_PASS  = process.env.CIMALPES_PASS;
const CI_BASE  = 'https://cimalpes.com/fr/flux/';

const TABLES = { Properties: 'tblnbjvrihjbiQJGq' };

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

function httpPatch(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

// ── Airtable helpers ──────────────────────────────────────────────────────────
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

// Write photo_url back to Airtable (fire-and-forget, non-blocking)
function writePhotosBack(updates) {
  if (!updates.length || !AT_KEY) return;
  const doWrite = async () => {
    const records = updates.map(u => ({ id: u.id, fields: { photo_url: u.photo_url } }));
    for (let i = 0; i < records.length; i += 10) {
      await httpPatch(
        `https://api.airtable.com/v0/${AT_BASE}/${TABLES.Properties}`,
        { records: records.slice(i, i + 10) },
        { Authorization: `Bearer ${AT_KEY}` }
      );
    }
  };
  doWrite().catch(e => console.error('Photo write-back failed:', e.message));
}

// ── Cimalpes XML helper ───────────────────────────────────────────────────────
function xmlGet(block, tag) {
  const marker = '<' + tag + '><![CDATA[';
  const idx = block.indexOf(marker);
  if (idx !== -1) {
    const s = idx + marker.length;
    const e = block.indexOf(']]>', s);
    return e === -1 ? '' : block.substring(s, e).trim();
  }
  const m = block.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
  return m ? m[1].trim() : '';
}

// Normalize date to YYYY-MM-DD (handles DD/MM/YYYY from Cimalpes)
function normalizeDate(s) {
  if (!s) return '';
  const dmy = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : s.trim();
}

// ── Cimalpes: photo map from ?fonction=biens ──────────────────────────────────
async function fetchPhotoMap() {
  if (!CI_LOGIN || !CI_PASS) return {};
  try {
    const url = `${CI_BASE}?fonction=biens`
      + `&login=${encodeURIComponent(CI_LOGIN)}`
      + `&pass=${encodeURIComponent(CI_PASS)}`;
    const xml = await withTimeout(httpGet(url), 15000);
    const map = {};
    const blocks = xml.split('<bien>').slice(1);
    for (const block of blocks) {
      const b = block.split('</bien>')[0];
      const id    = xmlGet(b, 'id_bien');
      const photo = xmlGet(b, 'photo_web');
      if (id && photo) map[id.trim()] = photo.trim();
    }
    return map;
  } catch (e) {
    console.error('fetchPhotoMap failed:', e.message);
    return {};
  }
}

// ── Cimalpes: pricing from ?fonction=infos ────────────────────────────────────
async function fetchPricing(cimalpes_id, checkin) {
  if (!cimalpes_id || !checkin || !CI_LOGIN || !CI_PASS) return null;
  try {
    const url = `${CI_BASE}?fonction=infos`
      + `&login=${encodeURIComponent(CI_LOGIN)}`
      + `&pass=${encodeURIComponent(CI_PASS)}`
      + `&id_bien=${cimalpes_id}`;
    const xml = await withTimeout(httpGet(url), 8000);
    const blocks = xml.split('<sejour>').slice(1);
    for (const block of blocks) {
      const b      = block.split('</sejour>')[0];
      const debut  = normalizeDate(xmlGet(b, 'date_debut'));
      if (debut !== checkin) continue;
      const fin     = normalizeDate(xmlGet(b, 'date_fin'));
      const montant = parseFloat(xmlGet(b, 'montant')) || 0;
      const etat    = xmlGet(b, 'etat_reservation').toLowerCase();
      if (montant > 0 && etat === 'libre') {
        return { checkin: debut, checkout: fin, weekly_price: montant, currency: 'EUR' };
      }
    }
    return null;
  } catch {
    return null;
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
    // ── Properties filter ─────────────────────────────────────────────────
    const pf = ["{status}='active'"];
    if (location && location !== 'any') pf.push(`{location}='${location}'`);
    if (guests && parseInt(guests) > 0)  pf.push(`{capacity}>=${parseInt(guests)}`);
    if (type   && type !== 'any')        pf.push(`{type}='${type}'`);
    const featList = features ? features.split(',').filter(Boolean) : [];
    for (const f of featList) {
      pf.push(`FIND('${f.replace(/'/g,"\\'")}',ARRAYJOIN({features},','))>0`);
    }
    const propFormula = pf.length > 1 ? `AND(${pf.join(',')})` : pf[0] || '1';

    // ── Parallel: Cimalpes biens (photo map) + Airtable Properties ───────
    const [photoMap, propRecords] = await Promise.all([
      fetchPhotoMap(),
      atPaginate(TABLES.Properties, {
        filterByFormula: propFormula,
        fields: ['name', 'type', 'location', 'bedrooms', 'bathrooms', 'capacity',
                 'features', 'cimalpes_id', 'description_en', 'photo_url'],
        maxRecords: 100,
      }).catch(e => { console.error('Properties failed:', e.message); return []; }),
    ]);

    // Sort: photos-first (Airtable photo_url or Cimalpes feed match), then alphabetical
    propRecords.sort((a, b) => {
      const aId = (a.fields.cimalpes_id || '').toString().trim();
      const bId = (b.fields.cimalpes_id || '').toString().trim();
      const aHas = !!(a.fields.photo_url || photoMap[aId]);
      const bHas = !!(b.fields.photo_url || photoMap[bId]);
      if (aHas !== bHas) return aHas ? -1 : 1;
      return (a.fields.name || '').localeCompare(b.fields.name || '');
    });

    const results = propRecords.slice(0, 20);

    // ── Pricing in parallel ───────────────────────────────────────────────
    const pricingList = await Promise.all(
      results.map(r => fetchPricing(r.fields.cimalpes_id || null, checkin || null))
    );

    // ── Build response + collect photos to write back to Airtable ─────────
    const photoWriteBack = [];

    let properties = results.map((r, i) => {
      const f      = r.fields;
      const cId    = (f.cimalpes_id || '').toString().trim();
      // Photo priority: Airtable cached > Cimalpes live feed
      const photo  = f.photo_url || photoMap[cId] || null;
      const pricing = pricingList[i] || null;

      // Lazy-cache: if we found a Cimalpes photo and Airtable doesn't have it yet, write back
      if (!f.photo_url && photoMap[cId]) {
        photoWriteBack.push({ id: r.id, photo_url: photoMap[cId] });
      }

      // Budget filter (only when pricing is known)
      const price = pricing ? pricing.weekly_price : null;
      if (budget_min && parseInt(budget_min) > 0 && price !== null && price < parseInt(budget_min)) return null;
      if (budget_max && parseInt(budget_max) > 0 && price !== null && price > parseInt(budget_max)) return null;

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
        photos:        photo ? [photo] : [],
        pricing,
      };
    }).filter(Boolean);

    // Sort: priced first (cheapest → most expensive), then by photo, then alphabetical
    properties.sort((a, b) => {
      if (a.pricing && b.pricing) return a.pricing.weekly_price - b.pricing.weekly_price;
      if (a.pricing) return -1;
      if (b.pricing) return 1;
      const aHas = a.photos.length > 0, bHas = b.photos.length > 0;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Fire-and-forget: persist newly found Cimalpes photos into Airtable
    writePhotosBack(photoWriteBack);

    return res.status(200).json({ properties, total: properties.length });

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message || 'Search failed. Please try again.' });
  }
};
