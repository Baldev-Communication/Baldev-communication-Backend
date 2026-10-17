const https = require('node:https');
const dns = require('node:dns').promises;
const { publicAddress } = require('../social-product-import/socialImport.network');
const configured = () => Boolean(process.env.BULK_IMPORT_CATALOG_URL);
// An operator-configured HTTPS catalog API, never a URL supplied by a cell.
// DNS is checked and pinned to prevent redirects and DNS rebinding into LANs.
async function lookup(identity) {
  if (!configured()) return [];
  const url = new URL(process.env.BULK_IMPORT_CATALOG_URL);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Catalog provider must use a credential-free HTTPS endpoint.');
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Catalog provider must resolve to a public address.');
  for (const [key, value] of Object.entries(identity)) if (value) url.searchParams.set(key, String(value));
  const selected = addresses[0];
  const buffer = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json', ...(process.env.BULK_IMPORT_CATALOG_TOKEN ? { Authorization: `Bearer ${process.env.BULK_IMPORT_CATALOG_TOKEN}` } : {}) }, lookup(_host, options, callback) { callback(null, options?.all ? [selected] : selected.address, selected.family); } }, res => {
      if (res.statusCode !== 200 || !/json/i.test(res.headers['content-type'] || '')) { res.resume(); reject(new Error('Configured catalog provider did not return JSON successfully.')); return; }
      let length = 0; const chunks = [];
      res.on('data', chunk => { length += chunk.length; if (length > 1024 * 1024) { req.destroy(new Error('Catalog response exceeds 1 MB.')); return; } chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Catalog provider timed out.'))); req.on('error', reject);
  });
  const data = JSON.parse(buffer.toString('utf8'));
  return Array.isArray(data.candidates) ? data.candidates.slice(0, 20) : [];
}
module.exports = { configured, lookup };
