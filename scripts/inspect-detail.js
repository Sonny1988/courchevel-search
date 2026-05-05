const https = require('https');
const fs = require('fs'), path = require('path');
const envPath = path.join(__dirname, '../../Luna/.env');
if (fs.existsSync(envPath)) fs.readFileSync(envPath,'utf8').split('\n').forEach(l=>{const[k,...v]=l.split('=');if(k&&v.length)process.env[k.trim()]=v.join('=').trim();});

const LOGIN = process.env.CIMALPES_LOGIN;
const PASS  = process.env.CIMALPES_PASS;

function httpGet(url) {
  return new Promise((r,j) => https.get(url, res => { const c=[]; res.on('data',d=>c.push(d)); res.on('end',()=>r(Buffer.concat(c).toString('utf8'))); }).on('error',j));
}

function xmlGet(block, tag) {
  const marker = '<' + tag + '><![CDATA[';
  const idx = block.indexOf(marker);
  if (idx !== -1) { const s = idx + marker.length; const e = block.indexOf(']]>', s); return e === -1 ? '' : block.substring(s, e).trim(); }
  const m = block.match(new RegExp('<' + tag + '>([^<]*)<\/' + tag + '>'));
  return m ? m[1].trim() : '';
}

async function main() {
  const biens = await httpGet(`https://cimalpes.com/fr/flux/?fonction=biens&login=${LOGIN}&pass=${PASS}`);
  const blocks = biens.split('<bien>').slice(1);

  // All distinct service levels + find chalets with high service
  const levels = new Set();
  const highEnd = [];
  for (const raw of blocks) {
    const b = raw.split('</bien>')[0];
    const station = xmlGet(b, 'nom_station');
    if (!station.includes('Courchevel')) continue;
    const svc = xmlGet(b, 'nom_bien_service_niveau_en');
    const type = xmlGet(b, 'type_bien');
    levels.add(svc);
    const id = xmlGet(b, 'id_bien');
    const name = xmlGet(b, 'nom_bien');
    // Pick high-end ones (likely to have amenities)
    if (svc && !svc.includes('Self-catered') && !svc.includes('Essential')) {
      highEnd.push({ id, name, svc, type });
    }
  }

  console.log('Service levels:', [...levels].filter(Boolean));
  console.log('\nHigh-end properties (first 8):');
  highEnd.slice(0, 8).forEach(p => console.log(' ', p.type, p.name, '-', p.svc, '(id=' + p.id + ')'));

  // Fetch detail for first chalet
  const target = highEnd.find(p => p.type === 'chalet') || highEnd[0];
  if (!target) { console.log('No target found'); return; }

  console.log('\n=== Detail for:', target.name, '===');
  const detail = await httpGet(`https://cimalpes.com/fr/flux/?fonction=detail&login=${LOGIN}&pass=${PASS}&id_bien=${target.id}`);

  // Print all node_ sections with content
  const nodeRe = new RegExp('<(node_[a-zA-Z_]+)>([\\s\\S]*?)<\\/\\1>', 'g');
  let m;
  while ((m = nodeRe.exec(detail)) !== null) {
    const content = m[2].trim();
    if (content.length > 5) {
      console.log('\n--- ' + m[1] + ' ---');
      console.log(content.substring(0, 600));
    }
  }

  // Key fields
  console.log('\n--- Key fields ---');
  ['nom_bien', 'nom_bien_service_niveau_en', 'id_gastronomie', 'gastronomie', 'criteres', 'wifi'].forEach(t => {
    const v = xmlGet(detail, t);
    if (v) console.log(t + ':', v.substring(0,100));
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
