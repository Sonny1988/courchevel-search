#!/usr/bin/env node
/**
 * populate-features.js
 * Fetches Cimalpes ?fonction=detail for each active property and maps
 * amenity keywords → Airtable feature values, then writes back.
 *
 * Usage:
 *   node scripts/populate-features.js --dry-run   → shows what would change, no writes
 *   node scripts/populate-features.js --run        → updates Airtable
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Load .env from Luna project
const envPath = path.join(__dirname, '../../Luna/.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

const LOGIN   = process.env.CIMALPES_LOGIN;
const PASS    = process.env.CIMALPES_PASS;
const AT_KEY  = process.env.AIRTABLE_API_KEY;
const AT_BASE = process.env.AIRTABLE_BASE_ID || 'app1gxPAbJp8AzH3i';
const AT_PROPS = 'tblnbjvrihjbiQJGq';
const DRY_RUN  = process.argv.includes('--dry-run');
const RUN      = process.argv.includes('--run') || DRY_RUN;

if (!LOGIN || !PASS)  { console.error('❌ CIMALPES_LOGIN / CIMALPES_PASS missing'); process.exit(1); }
if (RUN && !AT_KEY)   { console.error('❌ AIRTABLE_API_KEY missing'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Keyword → feature mapping (applied to lowercased full detail XML) ─────────
const KEYWORD_MAP = [
  // Pool
  { feature: 'pool',               keywords: ['swimming pool', 'piscine', 'pool '] },
  // Jacuzzi / hot tub
  { feature: 'jacuzzi',            keywords: ['jacuzzi', 'hot tub', 'bain nordique', 'bain à remous'] },
  // Sauna
  { feature: 'sauna',              keywords: ['sauna'] },
  // Spa (wellness area)
  { feature: 'spa',                keywords: ['>spa<', 'spa |', 'spa\n', '| spa', 'hammam', 'bien-être', 'wellness area'] },
  // Cinema
  { feature: 'cinema',             keywords: ['cinema', 'home cinema', 'salle cinéma', 'salle cinema', 'movie room'] },
  // Fireplace
  { feature: 'fireplace',          keywords: ['fireplace', 'cheminée', 'cheminee', 'log fire', 'wood fire'] },
  // Wine cellar
  { feature: 'wine-cellar',        keywords: ['wine cellar', 'cave à vin', 'cave a vin', 'wine room'] },
  // Ski-in / ski-out
  { feature: 'ski-in-out',         keywords: ['ski-in', 'ski-out', 'ski in', 'ski out', 'départ à ski', 'depart ski', 'pied des pistes', 'at the slopes'] },
  // Private chef
  { feature: 'private-chef-option',keywords: ['private chef', 'chef privé', 'chef prive', 'chef cuisinier'] },
  // Full catered service
  { feature: 'catered',            keywords: ['half-board', 'full board', 'demi-pension', 'pension complète', 'excellence'] },
  // Garage
  { feature: 'garage',             keywords: ['garage'] },
  // Terrace
  { feature: 'terrace',            keywords: ['terrace', 'terrasse', 'balcon'] },
];

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

function httpPatch(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: 'api.airtable.com',
      path: `/v0/${AT_BASE}/${AT_PROPS}`,
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString('utf8'))));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function atPaginate(params = {}) {
  const records = [];
  let offset = null;
  do {
    const parts = [];
    for (const [k, v] of Object.entries({ ...params, ...(offset ? { offset } : {}) })) {
      if (Array.isArray(v)) v.forEach(i => parts.push(`${encodeURIComponent(k+'[]')}=${encodeURIComponent(i)}`));
      else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    await sleep(220);
    const raw = await httpGet(
      `https://api.airtable.com/v0/${AT_BASE}/${AT_PROPS}?${parts.join('&')}`,
      { Authorization: `Bearer ${AT_KEY}` }
    );
    const res = JSON.parse(raw);
    if (res.error) throw new Error('Airtable: ' + JSON.stringify(res.error));
    records.push(...(res.records || []));
    offset = res.offset || null;
  } while (offset);
  return records;
}

// ── Extract features from Cimalpes detail XML ─────────────────────────────────
function extractFeaturesFromDetail(xml) {
  const lower = xml.toLowerCase();
  const found = new Set();
  for (const { feature, keywords } of KEYWORD_MAP) {
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        found.add(feature);
        break;
      }
    }
  }
  return [...found];
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Loading active Cimalpes properties from Airtable...');
  const records = await atPaginate({
    filterByFormula: "AND({status}='active',{cimalpes_id}!='')",
    fields: ['name', 'cimalpes_id', 'features'],
    maxRecords: 300,
  });
  console.log(`→ ${records.length} properties to process\n`);

  const toUpdate = [];
  let processed = 0;

  for (const r of records) {
    const cId = (r.fields.cimalpes_id || '').trim();
    if (!cId) continue;

    await sleep(300); // be gentle with Cimalpes API
    let xml;
    try {
      xml = await httpGet(
        `https://cimalpes.com/fr/flux/?fonction=detail&login=${encodeURIComponent(LOGIN)}&pass=${encodeURIComponent(PASS)}&id_bien=${cId}`
      );
    } catch (e) {
      console.warn(`  ⚠ Failed to fetch detail for ${r.fields.name} (id=${cId}): ${e.message}`);
      continue;
    }

    const ciFeatures = extractFeaturesFromDetail(xml);
    const currentFeatures = (r.fields.features || []).map(f => (typeof f === 'object' ? f.name : f));
    const merged = [...new Set([...currentFeatures, ...ciFeatures])];
    const added = merged.filter(f => !currentFeatures.includes(f));

    processed++;
    if (processed % 20 === 0) process.stdout.write(`  ${processed}/${records.length}...\n`);

    if (added.length === 0) continue;

    console.log(`  ✓ ${r.fields.name}: +[${added.join(', ')}]`);
    toUpdate.push({ id: r.id, features: merged });
  }

  console.log(`\n→ ${processed} processed, ${toUpdate.length} to update\n`);

  if (DRY_RUN || toUpdate.length === 0) {
    if (DRY_RUN) console.log('(dry-run — no writes)');
    return;
  }

  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += 10) {
    const batch = toUpdate.slice(i, i + 10).map(u => ({
      id: u.id,
      fields: { features: u.features },
    }));
    await sleep(220);
    const res = await httpPatch(`/${AT_PROPS}`, { records: batch, typecast: true });
    if (res.error) { console.error('Airtable error:', res.error); break; }
    updated += batch.length;
  }
  console.log(`✅ Done — ${updated} properties updated`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
