/**
 * One-shot sync: writes Cimalpes photo_web URLs into Airtable Properties.photo_url
 * GET /api/sync-photos  →  runs once, returns { updated, skipped, feedSize }
 */

const https = require('https');

const AT_KEY  = process.env.AIRTABLE_API_KEY;
const AT_BASE = process.env.AIRTABLE_BASE_ID || 'app1gxPAbJp8AzH3i';
const CI_LOGIN = process.env.CIMALPES_LOGIN;
const CI_PASS  = process.env.CIMALPES_PASS;
const CI_BASE  = 'https://cimalpes.com/fr/flux/';
const TABLE_ID = 'tblnbjvrihjbiQJGq';

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

async function atPaginate(params) {
  const records = [];
  let offset = null;
  do {
    const url = `https://api.airtable.com/v0/${AT_BASE}/${TABLE_ID}?${buildQS({ ...params, ...(offset ? { offset } : {}) })}`;
    const raw = await httpGet(url, { Authorization: `Bearer ${AT_KEY}` });
    const res = JSON.parse(raw);
    if (res.error) throw new Error(JSON.stringify(res.error));
    records.push(...(res.records || []));
    offset = res.offset || null;
  } while (offset);
  return records;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    // 1. Fetch Cimalpes biens feed → build photo map
    const bienUrl = `${CI_BASE}?fonction=biens`
      + `&login=${encodeURIComponent(CI_LOGIN)}`
      + `&pass=${encodeURIComponent(CI_PASS)}`;
    const xml = await httpGet(bienUrl);
    const photoMap = {};
    xml.split('<bien>').slice(1).forEach(block => {
      const b = block.split('</bien>')[0];
      const id    = xmlGet(b, 'id_bien');
      const photo = xmlGet(b, 'photo_web');
      if (id && photo) photoMap[id.trim()] = photo.trim();
    });

    // 2. Fetch all Airtable properties that have a cimalpes_id
    const records = await atPaginate({
      filterByFormula: "NOT({cimalpes_id}='')",
      fields: ['cimalpes_id', 'photo_url'],
    });

    // 3. Find records to update (Cimalpes has a photo, Airtable doesn't)
    const toUpdate = records.filter(r => {
      const cId = (r.fields.cimalpes_id || '').toString().trim();
      return photoMap[cId] && !r.fields.photo_url;
    });

    // 4. PATCH in batches of 10
    let updated = 0;
    for (let i = 0; i < toUpdate.length; i += 10) {
      const batch = toUpdate.slice(i, i + 10).map(r => ({
        id: r.id,
        fields: { photo_url: photoMap[r.fields.cimalpes_id.toString().trim()] },
      }));
      await httpPatch(
        `https://api.airtable.com/v0/${AT_BASE}/${TABLE_ID}`,
        { records: batch },
        { Authorization: `Bearer ${AT_KEY}` }
      );
      updated += batch.length;
    }

    return res.status(200).json({
      feedSize:  Object.keys(photoMap).length,
      atRecords: records.length,
      updated,
      skipped:   records.length - toUpdate.length,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
