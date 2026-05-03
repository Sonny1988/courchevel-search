/**
 * sync-all-photos.js
 * Fetches photos for ALL Airtable properties missing photo_url
 * using Cimalpes ?fonction=detail&id_bien={id}
 *
 * Usage: node scripts/sync-all-photos.js [--dry-run]
 */

// Load .env from this project or from the Luna project directory
const envPaths = [
  require('path').join(__dirname, '..', '.env'),
  require('path').join(require('os').homedir(), 'OneDrive', 'Desktop', 'Luna', '.env'),
];
for (const p of envPaths) {
  if (require('fs').existsSync(p)) { require('dotenv').config({ path: p }); break; }
}

const https = require('https');

const AT_KEY   = process.env.AIRTABLE_API_KEY;
const AT_BASE  = process.env.AIRTABLE_BASE_ID || 'app1gxPAbJp8AzH3i';
const TABLE_ID = 'tblnbjvrihjbiQJGq';
const CI_LOGIN = process.env.CIMALPES_LOGIN;
const CI_PASS  = process.env.CIMALPES_PASS;
const CI_BASE  = 'https://cimalpes.com/fr/flux/';

const DRY_RUN  = process.argv.includes('--dry-run');
const CONCURRENCY = 5;   // parallel Cimalpes requests
const DELAY_MS    = 300; // ms between batches

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ── Airtable ──────────────────────────────────────────────────────────────────

async function atPaginate(params) {
  const records = [];
  let offset = null;
  do {
    const url = `https://api.airtable.com/v0/${AT_BASE}/${TABLE_ID}?${buildQS({ ...params, ...(offset ? { offset } : {}) })}`;
    const raw = await httpGet(url, { Authorization: `Bearer ${AT_KEY}` });
    const res = JSON.parse(raw);
    if (res.error) throw new Error(`Airtable: ${JSON.stringify(res.error)}`);
    records.push(...(res.records || []));
    offset = res.offset || null;
  } while (offset);
  return records;
}

async function atPatchBatch(updates) {
  // updates: [{id, photo_url}]
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10).map(u => ({
      id: u.id,
      fields: { photo_url: u.photo_url },
    }));
    const raw = await httpPatch(
      `https://api.airtable.com/v0/${AT_BASE}/${TABLE_ID}`,
      { records: batch },
      { Authorization: `Bearer ${AT_KEY}` }
    );
    const res = JSON.parse(raw);
    if (res.error) throw new Error(`Airtable PATCH: ${JSON.stringify(res.error)}`);
    await sleep(200); // rate limit
  }
}

// ── Cimalpes ──────────────────────────────────────────────────────────────────

async function fetchFirstPhoto(cimalpesId) {
  try {
    const url = `${CI_BASE}?fonction=detail`
      + `&login=${encodeURIComponent(CI_LOGIN)}`
      + `&pass=${encodeURIComponent(CI_PASS)}`
      + `&id_bien=${cimalpesId}`;
    const xml = await withTimeout(httpGet(url), 10000);

    // Extract <node_photo> section
    const nodePhotoMatch = xml.match(/<node_photo>([\s\S]*?)<\/node_photo>/);
    if (!nodePhotoMatch) return null;

    // Get first <url size="original"> inside <photo ordre="1">
    const firstPhotoMatch = nodePhotoMatch[1].match(/<url[^>]*size="original"[^>]*>(.*?)<\/url>/);
    if (!firstPhotoMatch) return null;

    const url_ = firstPhotoMatch[1].trim();
    return url_ || null;
  } catch (e) {
    return null;
  }
}

// ── Pool executor ─────────────────────────────────────────────────────────────

async function runPool(items, fn, concurrency) {
  const results = new Array(items.length).fill(null);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Cimalpes Photo Sync${DRY_RUN ? ' [DRY RUN]' : ''} ===\n`);

  if (!AT_KEY || !CI_LOGIN || !CI_PASS) {
    throw new Error('Missing env vars: AIRTABLE_API_KEY, CIMALPES_LOGIN, CIMALPES_PASS');
  }

  // 1. Fetch Airtable records missing photo_url (with cimalpes_id)
  console.log('Fetching Airtable records without photo_url...');
  const records = await atPaginate({
    filterByFormula: "AND(NOT({cimalpes_id}=''), {photo_url}='')",
    fields: ['name', 'cimalpes_id', 'photo_url'],
  });
  console.log(`Found ${records.length} records without photo_url\n`);

  if (!records.length) {
    console.log('Nothing to do!');
    return;
  }

  // 2. Fetch first photo for each from Cimalpes detail endpoint
  let found = 0, notFound = 0;
  const updates = [];

  console.log(`Fetching photos from Cimalpes (${CONCURRENCY} concurrent)...`);
  const progress = { done: 0 };

  const photoResults = await runPool(records, async (r, i) => {
    const cId = (r.fields.cimalpes_id || '').toString().trim();
    const photo = await fetchFirstPhoto(cId);
    progress.done++;
    const pct = Math.round((progress.done / records.length) * 100);
    process.stdout.write(`\r  ${progress.done}/${records.length} (${pct}%) — ${r.fields.name || cId}${' '.repeat(20)}`);
    return { id: r.id, name: r.fields.name, cId, photo };
  }, CONCURRENCY);

  console.log('\n');

  for (const result of photoResults) {
    if (result.photo) {
      found++;
      updates.push({ id: result.id, photo_url: result.photo });
      console.log(`  ✓ ${result.name || result.cId}: ${result.photo.slice(0, 70)}...`);
    } else {
      notFound++;
      console.log(`  ✗ ${result.name || result.cId} (${result.cId}): no photo found`);
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  Found:    ${found}`);
  console.log(`  Missing:  ${notFound}`);
  console.log(`  To write: ${updates.length}`);

  // 3. Write back to Airtable
  if (!DRY_RUN && updates.length > 0) {
    console.log('\nWriting to Airtable...');
    await atPatchBatch(updates);
    console.log(`  ✓ ${updates.length} records updated`);
  } else if (DRY_RUN) {
    console.log('\n[DRY RUN] No writes performed.');
  }

  console.log('\nDone.');
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
