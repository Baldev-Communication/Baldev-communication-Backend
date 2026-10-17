const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin } = require('./factories');
const Product = require('../models/Product');
const InventoryTransaction = require('../models/InventoryTransaction');
const Category = require('../models/Category');

test.before(async () => { await startTestEnvironment(); await Product.init(); });
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

async function fixture() {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Products', slug: 'products' });
  const body = { name: 'Phone Model 256 GB', category: String(category._id), sku: 'PHONE-A', brand: 'Acme', attributeValues: { brand: 'Acme', model: 'Model 256', condition: 'New', warranty: '1 year' }, price: 1000, originalPrice: 1200, stock: 2, images: [{ url: '/uploads/test.jpg', primary: true }] };
  const save = (changes = {}) => request('/api/admin/products', { method: 'POST', token, body: { ...body, ...changes } });
  return { token, body, save };
}

test('different SKUs with the same product name save with separate usable URLs', async () => {
  const { save } = await fixture();
  const first = await save();
  const second = await save({ sku: 'PHONE-B' });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.notEqual(first.data.slug, second.data.slug);
  for (const result of [first, second]) {
    const detail = await request(`/api/products/${result.data.slug}`);
    assert.equal(detail.data._id, result.data._id);
  }
});

test('a restored form cannot reuse another product ID or attach a draft publication identity', async () => {
  const { save } = await fixture();
  const first = await save();
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const second = await save({ sku: 'PHONE-B', name: 'Another phone', _id: first.data._id, id: first.data._id,
    sourceDraftId: first.data._id, createdAt: '2000-01-01T00:00:00.000Z', inventoryRevision: 99 });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.notEqual(second.data._id, first.data._id);
  const saved = await Product.findById(second.data._id).lean();
  assert.equal(saved.sourceDraftId, undefined);
  assert.notEqual(saved.createdAt.getUTCFullYear(), 2000);
  assert.equal(saved.inventoryRevision, 0);
  assert.equal((await Product.findById(first.data._id)).sku, 'PHONE-A');
});

test('concurrent same-name uploads keep one opening inventory record per product', async () => {
  const { save } = await fixture();
  const results = await Promise.all(['PHONE-A', 'PHONE-B', 'PHONE-C'].map(sku => save({ sku })));
  assert.deepEqual(results.map(result => result.status), [201, 201, 201], JSON.stringify(results));
  assert.equal(new Set(results.map(result => result.data.slug)).size, 3);
  for (const result of results) {
    assert.equal(await InventoryTransaction.countDocuments({ product: result.data._id, idempotencyKey: `opening:${result.data._id}:product` }), 1);
  }
});

test('archived product SKUs remain reserved and identify the conflict clearly', async () => {
  const { save, token } = await fixture();
  const first = await save();
  await request(`/api/admin/products/${first.data._id}`, { method: 'DELETE', token });
  const duplicate = await save({ name: 'Another phone' });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.data));
  assert.match(duplicate.data.message, /SKU/i);
  assert.match(duplicate.data.message, /archived|restore/i);
  assert.doesNotMatch(duplicate.data.message, /storeId already exists/i);
  const allowed = await save({ sku: 'PHONE-B' });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
});

test('updating a restored product keeps its database ID and publication link', async () => {
  const { save, token } = await fixture();
  const first = await save();
  const other = await save({ sku: 'PHONE-B', name: 'Other phone' });
  await Product.updateOne({ _id: first.data._id }, { $set: { sourceDraftId: first.data._id } });
  const updated = await request(`/api/admin/products/${first.data._id}`, { method: 'PUT', token,
    body: { name: 'Updated phone', _id: other.data._id, sourceDraftId: other.data._id, inventoryRevision: 0 } });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data._id, first.data._id);
  assert.equal(String((await Product.findById(first.data._id)).sourceDraftId), first.data._id);
  assert.equal((await Product.findById(other.data._id)).name, 'Other phone');
});

test('an archived barcode remains reserved even for a different SKU', async () => {
  const { save, token } = await fixture();
  const first = await save({ barcode: '8900000000001' });
  await request(`/api/admin/products/${first.data._id}`, { method: 'DELETE', token });
  const duplicate = await save({ sku: 'PHONE-B', name: 'Other phone', barcode: '8900000000001' });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.data));
  assert.match(duplicate.data.message, /Barcode.*archived/i);
  assert.equal(await Product.countDocuments(), 1);
});

test('a concurrent repeat save with the same SKU cannot create another product or opening stock', async () => {
  const { save } = await fixture();
  const results = await Promise.all([save(), save()]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.match(results.find(result => result.status === 409).data.message, /SKU/i);
  assert.equal(await Product.countDocuments(), 1);
  assert.equal(await InventoryTransaction.countDocuments(), 1);
});
