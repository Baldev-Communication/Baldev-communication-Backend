const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const { createProvisionedSeller } = require('./accessFixtures');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

async function upload(route, field, bytes, type, name, token, headers = {}) {
  const body = new FormData();
  body.append(field, new Blob([bytes], { type }), name);
  const response = await fetch(`${getBaseUrl()}${route}`, { method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body });
  return { status: response.status, data: await response.json() };
}

test('upload access requires an authenticated admin or store member even with a forged local Host', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { process.env.NODE_ENV = previous; });
  for (const host of ['localhost', '127.0.0.1', 'localhost.attacker.test']) {
    for (const route of ['/api/admin/uploads', '/api/admin/uploads/videos', '/api/admin/upload']) {
      const response = await request(route, { method: 'POST', body: {}, headers: { Host: host } });
      assert.equal(response.status, 401, `${route} must not trust Host=${host}`);
    }
  }
  const customer = await createCustomer();
  assert.equal((await request('/api/admin/uploads', { method: 'POST', token: customer.token, body: {}, headers: { Host: 'localhost' } })).status, 403);
});

test('admin and seller multipart uploads retain playable media and provide retrievable public file URLs', async (t) => {
  const admin = await createAdmin(), seller = await createProvisionedSeller('Upload Fixture Store');
  const marker = `qa-upload-${crypto.randomUUID()}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'samira-upload-test-'));
  const videoPath = path.join(directory, `${marker}.mp4`);
  const uploadedPaths = [];
  t.after(async () => {
    await Promise.all(uploadedPaths.map(file => fs.unlink(file).catch(() => null)));
    await fs.unlink(videoPath).catch(() => null);
    await fs.rmdir(directory).catch(() => null);
  });
  const generated = spawnSync(require('ffmpeg-static'), ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=white:s=160x240:d=0.2','-pix_fmt','yuv420p',videoPath], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const video = await fs.readFile(videoPath);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4cGDDhwMbGCAUAEOOCYEIRcH9AAAAAElFTkSuQmCC', 'base64');
  for (const actor of [{ route: '/api/admin/uploads', token: admin.token, headers: {} }, { route: '/api/seller/uploads', token: seller.token, headers: { 'x-store-id': seller.store.id } }]) {
    for (const media of [{ suffix: '', field: 'images', bytes: image, type: 'image/png', extension: 'png' }, { suffix: '/videos', field: 'videos', bytes: video, type: 'video/mp4', extension: 'mp4' }]) {
      const result = await upload(`${actor.route}${media.suffix}`, media.field, media.bytes, media.type, `${marker}.${media.extension}`, actor.token, actor.headers);
      assert.equal(result.status, 201, JSON.stringify(result.data));
      assert.equal(result.data.files.length, 1);
      assert.equal(result.data.provider, 'local');
      const file = result.data.files[0];
      assert.equal(file.mimeType, media.type);
      assert.equal(file.sizeBytes, media.bytes.length);
      const resolved = path.resolve(__dirname, '..', 'uploads', path.basename(file.url));
      assert.equal(resolved.startsWith(path.resolve(__dirname, '..', 'uploads') + path.sep), true);
      assert.equal(path.basename(resolved).includes(marker), true);
      uploadedPaths.push(resolved);
      assert.deepEqual(await fs.readFile(resolved), media.bytes);
      const download = await fetch(`${getBaseUrl()}${file.url}`);
      assert.equal(download.status, 200);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), media.bytes);
    }
  }
});

test('invalid media and missing files are explained as validation errors without a server failure', async () => {
  const admin = await createAdmin();
  const video = await upload('/api/admin/uploads/videos', 'videos', Buffer.from('not-video'), 'text/plain', 'invalid.txt', admin.token);
  assert.equal(video.status, 400);
  assert.equal(video.data.code, 'VALIDATION_ERROR');
  assert.match(video.data.message, /mp4|webm|mov/i);
  const image = await upload('/api/admin/uploads', 'images', Buffer.from('not-image'), 'text/plain', 'invalid.txt', admin.token);
  assert.equal(image.status, 400);
  assert.equal((await request('/api/admin/uploads', { method: 'POST', token: admin.token, body: {} })).status, 400);
});

test('review and return evidence photos require customer authentication and valid image bytes', async (t) => {
  const customer = await createCustomer();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4cGDDhwMbGCAUAEOOCYEIRcH9AAAAAElFTkSuQmCC', 'base64');
  const unauthenticated = await upload('/api/reviews/uploads', 'images', png, 'image/png', 'review.png');
  assert.equal(unauthenticated.status, 401);
  const spoofed = await upload('/api/reviews/uploads', 'images', Buffer.from('not-an-image'), 'image/png', 'spoofed.png', customer.token);
  assert.equal(spoofed.status, 400);
  assert.match(spoofed.data.message, /valid JPG, PNG, or WEBP/i);
  const valid = await upload('/api/reviews/uploads', 'images', png, 'image/png', 'customer-review.png', customer.token);
  assert.equal(valid.status, 201, JSON.stringify(valid.data));
  assert.equal(valid.data.files.length, 1);
  const stored = path.resolve(__dirname, '..', 'uploads', path.basename(valid.data.files[0].url));
  t.after(() => fs.unlink(stored).catch(() => null));
  assert.deepEqual(await fs.readFile(stored), png);
  const returnUnauthenticated = await upload('/api/returns/uploads', 'images', png, 'image/png', 'return.png');
  assert.equal(returnUnauthenticated.status, 401);
  const returnSpoofed = await upload('/api/returns/uploads', 'images', Buffer.from('not-an-image'), 'image/png', 'spoofed-return.png', customer.token);
  assert.equal(returnSpoofed.status, 400);
  const returnValid = await upload('/api/returns/uploads', 'images', png, 'image/png', 'customer-return.png', customer.token);
  assert.equal(returnValid.status, 201, JSON.stringify(returnValid.data));
  assert.equal(returnValid.data.files.length, 1);
  const returnStored = path.resolve(__dirname, '..', 'uploads', path.basename(returnValid.data.files[0].url));
  t.after(() => fs.unlink(returnStored).catch(() => null));
  assert.deepEqual(await fs.readFile(returnStored), png);
});

test('bulk-uploaded draft photos remain available through editing and publication with local storage', async (t) => {
  const admin = await createAdmin();
  const marker = `qa-bulk-${crypto.randomUUID()}`;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4cGDDhwMbGCAUAEOOCYEIRcH9AAAAAElFTkSuQmCC', 'base64');
  const result = await upload('/api/admin/product-drafts/bulk-upload', 'images', image, 'image/png', `${marker}.png`, admin.token);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const draft = result.data.data.drafts[0];
  const filePath = path.resolve(__dirname, '..', 'uploads', path.basename(new URL(draft.image, getBaseUrl()).pathname));
  assert.equal(path.basename(filePath).includes(marker), true);
  t.after(() => fs.unlink(filePath).catch(() => null));
  const optimized = await fs.readFile(filePath);
  assert.equal((await require('sharp')(optimized).metadata()).format, 'webp');
  assert.ok(optimized.length <= 700 * 1024, 'the draft photo should be compressed before storage');
  assert.equal((await request('/api/admin/product-drafts', { token: admin.token })).data.data.length, 1);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { token: admin.token })).data.data.image, draft.image);
  const category = await require('../models/Category').create({ name: 'Sarees', slug: 'bulk-sarees' });
  const edited = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token: admin.token, body: { name: 'Rose Silk Saree', brand: 'Baldev Communication', attributeValues: { brand: 'Baldev Communication', model: 'TEST-1', condition: 'New', warranty: 'No warranty' }, category: String(category._id), price: 799, sellingPrice: 799, originalPrice: 999, stock: 4, sizingMode: 'free-size', colors: ['Rose'] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const published = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token, body: { ids: [draft._id] } });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.data.products[0].name, 'Rose Silk Saree');
  const served = await fetch(`${getBaseUrl()}${new URL(draft.image, getBaseUrl()).pathname}`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), optimized);
});

test('one upload creates independent four, three and two photo drafts with mobile model seeds', async (t) => {
  const admin = await createAdmin();
  const category = await require('../models/Category').create({ name: 'Smartphones', slug: 'smartphones', definitionKey: 'smartphones' });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4cGDDhwMbGCAUAEOOCYEIRcH9AAAAAElFTkSuQmCC', 'base64');
  const body = new FormData();
  for (let index = 0; index < 9; index++) body.append('images', new Blob([image], { type: 'image/png' }), `group-${index}.png`);
  body.append('groupMode', 'grouped');
  body.append('photoGroups', JSON.stringify([1, 1, 1, 1, 2, 2, 2, 3, 3]));
  body.append('groupDetails', JSON.stringify({
    1: { category: String(category._id), model: 'Apple iPhone 17', ram: '8', storage: '256', sellingPrice: '39999', originalPrice: '49999', stock: '2', costPrice: '30000', gstRate: '18', condition: 'Used', warranty: '3 months seller warranty', brand: 'Apple',
      sku: 'APPLE-MANUAL-01', supplierSku: 'SUP-1', barcode: '1234567890', countryOfOrigin: 'India', shippingWeightKg: '0.5', packageDimensions: { lengthCm: '20', widthCm: '10', heightCm: '5' }, attributeValues: { dimensions: '150 x 75 x 8 mm', box_contents: 'Phone only' } },
    2: { category: String(category._id), model: 'Galaxy A15', ram: '8', storage: '128', sellingPrice: '14999', originalPrice: '19999', stock: '0', condition: 'New' },
    3: { category: String(category._id), model: 'Pixel 10', ram: '8', storage: '256', sellingPrice: '45999', originalPrice: '59999', stock: '1', condition: 'Refurbished' },
  }));
  const response = await fetch(`${getBaseUrl()}/api/admin/product-drafts/bulk-upload`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  const drafts = result.data.drafts;
  assert.deepEqual(drafts.map(draft => draft.images.length), [4, 3, 2]);
  assert.deepEqual(drafts.map(draft => draft.name), ['Apple iPhone 17', 'Galaxy A15', 'Pixel 10']);
  assert.equal(drafts[0].attributeValues.storage, '256');
  assert.deepEqual(drafts.map(draft => draft.sellingPrice), [39999, 14999, 45999]);
  assert.deepEqual(drafts.map(draft => draft.stock), [2, 0, 1]);
  assert.deepEqual(drafts.map(draft => draft.attributeValues.condition), ['Used', 'New', 'Refurbished']);
  assert.equal(drafts[0].sku, 'APPLE-MANUAL-01'); assert.equal(drafts[0].warranty, '3 months seller warranty');
  const saved = await request(`/api/admin/product-drafts/${drafts[0]._id}`, { token: admin.token });
  assert.equal(saved.data.data.sellingPrice, 39999); assert.equal(saved.data.data.supplierSku, 'SUP-1');
  assert.equal(saved.data.data.shippingWeightKg, 0.5); assert.deepEqual(saved.data.data.packageDimensions, { lengthCm: 20, widthCm: 10, heightCm: 5 });
  assert.equal(saved.data.data.attributeValues.dimensions, '150 x 75 x 8 mm'); assert.equal(saved.data.data.attributeValues.box_contents, 'Phone only');
  assert.equal(drafts[0].images[0].primary, true);
  assert.equal(new Set(drafts.flatMap(draft => draft.images.map(photo => photo.url))).size, 9);
  t.after(async () => {
    await Promise.all(drafts.flatMap(draft => draft.images.map(photo => fs.unlink(path.resolve(__dirname, '..', 'uploads', path.basename(new URL(photo.url, getBaseUrl()).pathname))).catch(() => null))));
  });
});

test('quick photo analysis sends the actual uploaded image, maps categories and leaves commercial fields manual', async (t) => {
  const admin = await createAdmin(), seller = await createProvisionedSeller('Photo Analysis Store');
  await require('../models/Store').updateOne({ _id: seller.store.id }, { $set: { plan: 'PROFESSIONAL' } });
  assert.equal((await request('/api/admin/products/quick-analyze/status', { token: admin.token })).data.enabled, false);
  const unavailable = await request('/api/admin/products/quick-analyze', { method: 'POST', token: admin.token, body: {} });
  assert.equal(unavailable.status, 200); assert.equal(unavailable.data.enabled, false);
  process.env.GEMINI_API_KEY = 'isolated-photo-analysis-fixture';
  t.after(() => { delete process.env.GEMINI_API_KEY; });
  const marker = `qa-analysis-${crypto.randomUUID()}.png`;
  const filePath = path.join(__dirname, '..', 'uploads', marker);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4cGDDhwMbGCAUAEOOCYEIRcH9AAAAAElFTkSuQmCC', 'base64');
  await fs.writeFile(filePath, image);
  t.after(() => fs.unlink(filePath).catch(() => null));
  const originalFetch = global.fetch;
  let providerCalls = 0, quotaExceeded = false;
  t.mock.method(global, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === '127.0.0.1') return originalFetch(url, options);
    assert.equal(parsed.hostname, 'generativelanguage.googleapis.com');
    providerCalls += 1;
    const sent = JSON.parse(options.body);
    assert.equal(sent.contents[0].parts[1].inlineData.data, image.toString('base64'));
    if (quotaExceeded) return { ok: false, status: 429, json: async () => ({ error: { message: 'Fixture quota exhausted' } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ name: 'Rose Floral Saree', categoryName: 'Sarees', colors: ['Rose'], pattern: 'Floral', fabric: 'Silk', tags: ['Saree','Floral'], description: 'Rose floral saree.', price: 999, stock: 25, confidence: { overall: 0.9 } }) }] } }] }) };
  });
  const categories = [{ _id: '0123456789abcdef01234567', name: 'Sarees' }];
  for (const actor of [{ prefix: '/api/admin', token: admin.token }, { prefix: '/api/seller', token: seller.token, headers: { 'x-store-id': seller.store.id } }]) {
    assert.equal((await request(`${actor.prefix}/products/quick-analyze/status`, actor)).data.enabled, true);
    const result = await request(`${actor.prefix}/products/quick-analyze`, { ...actor, method: 'POST', body: { imageUrl: `/uploads/${marker}`, categories } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.suggestion.name, 'Rose Floral Saree');
    assert.equal(result.data.suggestion.categoryId, categories[0]._id);
    assert.equal(result.data.suggestion.sizingMode, 'free-size');
    assert.equal(result.data.suggestion.price, undefined); assert.equal(result.data.suggestion.stock, undefined);
  }
  assert.equal(providerCalls, 2);
  quotaExceeded = true;
  const failed = await request('/api/admin/products/quick-analyze', { method: 'POST', token: admin.token, body: { imageUrl: `/uploads/${marker}`, categories } });
  assert.equal(failed.status, 400);
  assert.match(failed.data.message, /quota/i);
  assert.equal(providerCalls, 3, 'quota failure must not repeatedly spend provider requests');
});
