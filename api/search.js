/**
 * Vercel Serverless Function — /api/search
 * Primary source: Cimalpes API (photos + pricing via ?fonction=infos)
 * Fallback for pricing only: Airtable Pricing table
 *
 * Required env vars:
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID   (default: app1gxPAbJp8AzH3i)
 *   CIMALPES_LOGIN
 *   CIMALPES_PASS
 */

const https = require('https');

const AT_KEY   = process.env.AIRTABLE_API_KEY;
const AT_BASE  = process.env.AIRTABLE_BASE_ID || 'app1gxPAbJp8AzH3i';
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

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
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

// ── Cimalpes XML helpers ──────────────────────────────────────────────────────
function xmlGet(block, tag) {
  const cdataMarker = '<' + tag + '><![CDATA[';
  const idx = block.indexOf(cdataMarker);
  if (idx !== -1) {
    const s = idx + cdataMarker.length;
    const e = block.indexOf(']]>', s);
    return e === -1 ? '' : block.substring(s, e).trim();
  }
  const m = block.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
  return m ? m[1].trim() : '';
}

function extractPhotos(xml) {
  const pat = /https:\/\/admin\.cimalpes\.com\/photos\/bien\/\d+\/[^\s"'<>\]\[]+/g;
  const found = [];
  let m;
  while ((m = pat.exec(xml)) !== null) {
    if (!found.includes(m[0])) found.push(m[0]);
  }
  return found.slice(0, 8);
}

// Find the sejour matching the checkin date and return pricing
function extractPricing(xml, checkin) {
  const blocks = xml.split('<sejour>').slice(1);
  for (const block of blocks) {
    const b = block.split('</sejour>')[0];
    const debut = xmlGet(b, 'date_debut');
    if (debut !== checkin) continue;
    const fin     = xmlGet(b, 'date_fin');
    const montant = parseFloat(xmlGet(b, 'montant')) || 0;
    const etat    = xmlGet(b, 'etat_reservation');
    if (montant > 0 && etat === 'libre') {
      return { checkin: debut, checkout: fin, weekly_price: montant, currency: 'EUR' };
    }
  }
  return null;
}

// Fetch photos + pricing from Cimalpes infos endpoint (single call)
async function getCimalepesData(cimalpes_id, checkin) {
  if (!cimalpes_id || !CI_LOGIN || !CI_PASS) return { photos: [], pricing: null };
  try {
    const url = `${CI_BASE}?fonction=infos`
      + `&login=${encodeURIComponent(CI_LOGIN)}`
      + `&pass=${encodeURIComponent(CI_PASS)}`
      + `&id_bien=${cimalpes_id}`;
    const xml = await Promise.race([
      httpGet(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    return {
      photos:  extractPhotos(xml),
      pricing: checkin ? extractPricing(xml, checkin) : null,
    };
  } catch {
    return { photos: [], pricing: null };
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
    if (guests && parseInt(guests) > 0) pf.push(`{capacity}>=${parseInt(guests)}`);
    if (type   && type !== 'any')       pf.push(`{type}='${type}'`);
    const featList = features ? features.split(',').filter(Boolean) : [];
    for (const f of featList) {
      pf.push(`FIND('${f.replace(/'/g,"\\'")}',ARRAYJOIN({features},','))>0`);
    }
    const propFormula = pf.length > 1 ? `AND(${pf.join(',')})` : pf[0] || '1';

    // ── Fetch Properties from Airtable ────────────────────────────────────
    let propRecords = [];
    try {
      propRecords = await atPaginate(TABLES.Properties, {
        filterByFormula: propFormula,
        fields: ['name', 'type', 'location', 'bedrooms', 'bathrooms', 'capacity',
                 'features', 'cimalpes_id', 'description_en'],
        maxRecords: 100,
      });
    } catch (e) { console.error('Properties query failed:', e.message); }

    // Sort alphabetically, take first 20
    propRecords.sort((a, b) => (a.fields.name || '').localeCompare(b.fields.name || ''));
    const results = propRecords.slice(0, 20);

    // ── Fetch Cimalpes data (photos + pricing) in parallel ────────────────
    // Primary source: Cimalpes API. One call per property gets both.
    const cimalepesData = await Promise.all(
      results.map(r => getCimalepesData(r.fields.cimalpes_id || null, checkin || null))
    );

    // ── Airtable Pricing fallback for properties without Cimalpes pricing ─
    let fallbackMap = {};
    if (checkin) {
      try {
        const prF = ["{status}='available'", `{checkin}='${checkin}'`];
        const pricingRecords = await atPaginate(TABLES.Pricing, {
          filterByFormula: `AND(${prF.join(',')})`,
          fields: ['property', 'checkin', 'checkout', 'weekly_price', 'currency'],
          maxRecords: 300,
        });
        for (const r of pricingRecords) {
          for (const pid of (r.fields.property || [])) {
            if (!fallbackMap[pid]) {
              fallbackMap[pid] = {
                checkin:      r.fields.checkin,
                checkout:     r.fields.checkout,
                weekly_price: r.fields.weekly_price,
                currency:     r.fields.currency || 'EUR',
              };
            }
          }
        }
      } catch (e) { console.error('Pricing fallback failed:', e.message); }
    }

    // ── Build response ────────────────────────────────────────────────────
    let properties = results.map((r, i) => {
      const f  = r.fields;
      const cd = cimalepesData[i];
      // Cimalpes pricing wins; Airtable is fallback only
      const pricing = cd.pricing || fallbackMap[r.id] || null;

      // Apply budget filter against actual pricing
      const price = pricing ? pricing.weekly_price : null;
      if (budget_min && parseInt(budget_min) > 0 && price && price < parseInt(budget_min)) return null;
      if (budget_max && parseInt(budget_max) > 0 && price && price > parseInt(budget_max)) return null;

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
        photos:        cd.photos,
        pricing,
      };
    }).filter(Boolean);

    // Sort: priced properties first (cheapest → most expensive), then unpriced
    properties.sort((a, b) => {
      if (a.pricing && b.pricing) return a.pricing.weekly_price - b.pricing.weekly_price;
      if (a.pricing) return -1;
      if (b.pricing) return 1;
      return a.name.localeCompare(b.name);
    });

    return res.status(200).json({ properties, total: properties.length });

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message || 'Search failed. Please try again.' });
  }
};
