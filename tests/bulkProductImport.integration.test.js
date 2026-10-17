const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { request, startTestEnvironment, stopTestEnvironment, resetDatabase } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const { Batch, Row } = require('../modules/bulk-product-import/models');
const { processOneBatch } = require('../modules/bulk-product-import/worker');
const ProductDraft = require('../models/ProductDraft');
const Product = require('../models/Product');
const { toCsv } = require('../modules/bulk-product-import/spreadsheet');
let baseUrl;
test.before(async () => { ({ baseUrl } = await startTestEnvironment()); });
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);
async function setup() {
  const { token, user } = await createAdmin();
  const category = await request('/api/admin/categories', { token, method: 'POST', body: { name: 'Digital Watches', slug: 'digital-watches', definitionKey: 'watches', customAttributes: [{ key: 'custom_finish', label: 'Case finish', type: 'dropdown', options: ['Matte', 'Gloss'], required: false }] } });
  assert.equal(category.status, 201, JSON.stringify(category.data));
  return { token, user, category: category.data };
}
const headers = ['Product Name', 'Category', 'Brand', 'Model', 'Condition', 'MRP', 'SP', 'Quantity', 'SKU', 'Warranty'];
const dataRow = (overrides = {}) => ['Casio F-91W', 'Digital Watches', 'Casio', 'F-91W', 'New', '2000', '1500', '2', `W-${crypto.randomUUID().slice(0, 8)}`, '1 year'].map((value, index) => Object.hasOwn(overrides, headers[index]) ? overrides[headers[index]] : value);
async function upload(token, rows, { filename = 'supplier.csv', buffer, key = crypto.randomUUID() } = {}) {
  const form = new FormData(); form.append('uploadKey', key); form.append('file', new Blob([buffer || toCsv([headers, ...rows])]), filename);
  const response = await fetch(`${baseUrl}/api/admin/product-imports`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: response.status, data: await response.json() };
}
async function drain(id) {
  for (let i = 0; i < 100; i++) {
    const batch = await Batch.findById(id).lean();
    if (!['editing', 'validating', 'queued', 'processing'].includes(batch.status)) return batch;
    await processOneBatch(id);
  }
  throw new Error('Import did not finish.');
}
async function mapped(token, rows, options = {}) {
  const uploaded = await upload(token, rows, options);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  const batch = uploaded.data;
  const response = await request(`/api/admin/product-imports/${batch._id}/mapping`, { token, method: 'PUT', body: { revision: batch.revision, mappings: Object.fromEntries(Object.entries(batch.mappings).map(([key, values]) => [key, values.map(value => value || '_ignore')])), sheets: batch.sheets.filter(sheet => sheet.selected).map(sheet => sheet.name), mode: options.mode || 'create', updateFields: options.updateFields || [] } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const done = await drain(batch._id);
  assert.equal(done.lastError || '', '', JSON.stringify(done));
  return { batch: done, rows: await Row.find({ batchId: batch._id }).sort({ rowNumber: 1 }).lean() };
}
async function commit(token, batch, ids) {
  const response = await request(`/api/admin/product-imports/${batch._id}/commit`, { token, method: 'POST', body: { revision: batch.revision, confirm: true, ids } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return drain(batch._id);
}
test('CSV supplier aliases create image-free existing ProductDraft records, preserve prices and retry identities', async () => {
  const { token } = await setup();
  const { batch, rows } = await mapped(token, [dataRow({ SP: '₹32,999', MRP: '35000', SKU: 'IMPORT-ONE' })]);
  assert.equal(rows[0].state, 'incomplete_draft', JSON.stringify(rows[0]));
  assert.equal(rows[0].payload.sellingPrice, 32999);
  await commit(token, batch, [rows[0]._id]);
  const draft = await ProductDraft.findById(rows[0].draftId).lean();
  assert.equal(draft.sourceType, 'bulk-import'); assert.equal(draft.sellingPrice, 32999); assert.equal(draft.stock, 2); assert.equal(draft.images.length, 0);
  assert.equal(await Product.countDocuments(), 0);
  await Row.updateOne({ _id: rows[0]._id }, { $set: { processed: false, approved: true } });
  await Batch.updateOne({ _id: batch._id }, { $set: { status: 'queued', job: 'commit' } });
  await drain(batch._id);
  assert.equal(await ProductDraft.countDocuments({ sourceImportBatchId: batch._id }), 1);
});
test('invalid amounts, unknown categories, duplicate file SKUs, unsupported options and missing required fields remain visible', async () => {
  const { token, category } = await setup();
  await require('../models/Category').updateOne({ _id: category._id }, { $set: { 'customAttributes.0.required': true } });
  const { rows } = await mapped(token, [dataRow({ SP: '-1' }), dataRow({ Category: 'Unknown category' }), dataRow({ SKU: 'SAME' }), dataRow({ SKU: 'SAME' }), dataRow({ Condition: 'Good' }), dataRow({ Brand: '', Model: '' })]);
  assert.equal(rows[0].state, 'invalid'); assert.equal(rows[1].state, 'needs_review');
  assert.equal(rows[2].state, 'duplicate'); assert.equal(rows[3].state, 'duplicate');
  assert.equal(rows[4].state, 'invalid'); assert.equal(rows[5].state, 'incomplete_draft');
  assert.ok(rows[5].issues.some(item => item.field === 'attributeValues.custom_finish' && item.severity === 'missing'));
});
test('dynamic XLSX templates round trip actual configured fields and mixed categories across explicit sheets', async () => {
  const { token, category } = await setup();
  const other = await request('/api/admin/categories', { token, method: 'POST', body: { name: 'Washing Machines', slug: 'washing-machines', definitionKey: 'washing_machines', customAttributes: [{ key: 'custom_drum', label: 'Drum coating', type: 'text' }] } });
  assert.equal(other.status, 201);
  const response = await fetch(`${baseUrl}/api/admin/product-imports/template?category=${category._id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const fields = workbook.getWorksheet('Products').getRow(1).values;
  assert.ok(fields.includes('Spec: Case finish [custom_finish]'));
  assert.ok(workbook.getWorksheet('Fields').rowCount > 10);
  const file = new ExcelJS.Workbook(); const a = file.addWorksheet('Supplier A'); a.addRow([...headers, 'custom_finish']); a.addRow([...dataRow(), 'Matte']);
  const b = file.addWorksheet('Supplier B'); b.addRow([...headers, 'custom_drum']); b.addRow([...dataRow({ 'Product Name': 'Washer exact model', Category: 'Washing Machines', Brand: 'Brand', Model: 'WM-7' }), 'Steel']);
  const result = await mapped(token, [], { filename: 'mixed.xlsx', buffer: Buffer.from(await file.xlsx.writeBuffer()) });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].payload.attributeValues.custom_finish, 'Matte');
  assert.equal(result.rows[1].payload.attributeValues.custom_drum, 'Steel');
  assert.notEqual(result.rows[0].payload.category, result.rows[1].payload.category);
});
test('blank update cells preserve existing values and explicit commercial mappings use the existing inventory ledger', async () => {
  const { token, category } = await setup();
  const created = await request('/api/admin/products', { method: 'POST', token, body: { name: 'Casio F-91W', sku: 'EXISTING', category: category._id, price: 1500, originalPrice: 2000, stock: 3, images: [{ url: '/uploads/watch.webp', primary: true }], attributeValues: { brand: 'Casio', model: 'F-91W', condition: 'New' }, warranty: '2 years' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const result = await mapped(token, [dataRow({ SKU: 'EXISTING', SP: '1499', Quantity: '5', Warranty: '', MRP: '' })], { mode: 'update', updateFields: ['price', 'stock', 'warranty', 'originalPrice'] });
  assert.equal(result.rows[0].state, 'ready', JSON.stringify(result.rows[0]));
  await commit(token, result.batch, [result.rows[0]._id]);
  const product = await Product.findById(created.data._id).lean();
  assert.equal(product.price, 1499); assert.equal(product.originalPrice, 2000); assert.equal(product.warranty, '2 years'); assert.equal(product.stock, 5); assert.equal(product.images.length, 1);
  assert.equal(await require('../models/InventoryTransaction').countDocuments({ product: product._id }), 2);
});
test('existing SKU requires an explicit update mode; stale approval cannot overwrite a concurrent edit', async () => {
  const { token, category } = await setup();
  const created = await request('/api/admin/products', { method: 'POST', token, body: { name: 'Casio F-91W', sku: 'STALE', category: category._id, price: 1500, originalPrice: 2000, stock: 3, images: [{ url: '/uploads/watch.webp' }], attributeValues: { brand: 'Casio', model: 'F-91W', condition: 'New' } } });
  assert.equal(created.status, 201);
  const duplicate = await mapped(token, [dataRow({ SKU: 'STALE' })]); assert.equal(duplicate.rows[0].state, 'duplicate');
  const result = await mapped(token, [dataRow({ SKU: 'STALE', SP: '1499' })], { mode: 'update', updateFields: ['price'] });
  await Product.updateOne({ _id: created.data._id }, { $set: { price: 1400 } });
  await commit(token, result.batch, [result.rows[0]._id]);
  assert.equal((await Row.findById(result.rows[0]._id)).state, 'failed');
  assert.equal((await Product.findById(created.data._id)).price, 1400);
});
test('imports reject unauthenticated users, customer accounts, formula cells and spoofed file types', async () => {
  const { token } = await setup(); const customer = await createCustomer();
  assert.equal((await request('/api/admin/product-imports/metadata')).status, 401);
  assert.equal((await request('/api/admin/product-imports/metadata', { token: customer.token })).status, 403);
  assert.equal((await upload(token, [], { filename: 'bad.xlsx', buffer: Buffer.from('not a zip') })).status, 400);
  const file = new ExcelJS.Workbook(); const sheet = file.addWorksheet('Products'); sheet.addRow(headers); sheet.addRow(dataRow()); sheet.getCell('G2').value = { formula: '1+1', result: 2 };
  const result = await mapped(token, [], { filename: 'formula.xlsx', buffer: Buffer.from(await file.xlsx.writeBuffer()) });
  assert.equal(result.rows[0].state, 'invalid'); assert.ok(result.rows[0].issues.some(item => /Formula/.test(item.message)));
});

test('300 image-free products are processed in persistent chunks without creating public products', async () => {
  const { token } = await setup();
  const result = await mapped(token, Array.from({ length: 300 }, (_, i) => dataRow({ SKU: `LARGE-${i}`, 'Product Name': `Watch ${i}` })));
  assert.equal(result.rows.length, 300);
  const done = await commit(token, result.batch, result.rows.map(row => row._id));
  assert.equal(done.summary.created_draft, 300); assert.equal(done.jobDone, 300);
  assert.equal(await ProductDraft.countDocuments({ sourceImportBatchId: result.batch._id }), 300);
  assert.equal(await Product.countDocuments(), 0);
});
test('variant sheets create one parent draft with separate SKUs, prices and inventory', async () => {
  const { token } = await setup();
  const book = new ExcelJS.Workbook(); const parents = book.addWorksheet('Products'); parents.addRow(headers); parents.addRow(dataRow({ SKU: 'PARENT' }));
  const variants = book.addWorksheet('Variants'); variants.addRow(['Row Type', 'Parent SKU', 'SKU', 'SP', 'MRP', 'Quantity', 'Variant Options']);
  variants.addRow(['variant', 'PARENT', 'P-BLACK', 1000, 1500, 3, '{"colour":"Black"}']);
  variants.addRow(['variant', 'PARENT', 'P-SILVER', 1200, 1600, 4, '{"colour":"Silver"}']);
  const result = await mapped(token, [], { filename: 'variants.xlsx', buffer: Buffer.from(await book.xlsx.writeBuffer()) });
  const parent = result.rows.find(row => row.rowKind === 'product');
  assert.equal(parent.state, 'incomplete_draft', JSON.stringify(parent));
  assert.equal(parent.payload.variants.length, 2);
  await commit(token, result.batch, [parent._id]);
  const saved = await ProductDraft.findById(parent.draftId).lean();
  assert.equal(saved.variants[1].price, 1200); assert.equal(saved.variants[0].stock, 3); assert.equal(saved.stock, 7);
  assert.equal(await ProductDraft.countDocuments(), 1);
  const attached = await request(`/api/admin/product-imports/${result.batch._id}/rows/${parent._id}/images`, { method: 'POST', token, body: { images: [{ url: '/uploads/variant-watch.webp', primary: true }] } });
  assert.equal(attached.status, 200);
  const publish = await request(`/api/admin/product-imports/${result.batch._id}/publish`, { method: 'POST', token, body: { ids: [parent._id], confirm: true } });
  assert.equal(publish.data.success, true, JSON.stringify(publish.data));
  const product = await Product.findOne().lean(); assert.equal(product.variants.length, 2); assert.equal(product.stock, 7);
  const customer = await createCustomer();
  const cart = await request('/api/cart', { token: customer.token, method: 'POST', body: { product: String(product._id), variantId: String(product.variants[1]._id), quantity: 1 } });
  assert.equal(cart.status, 201, JSON.stringify(cart.data));
  assert.equal(cart.data.items[0].price, 1200);
  assert.equal(cart.data.items[0].product.variants[1].optionValues.colour, 'Silver');
});
test('image matches use exact SKU punctuation; later images and explicit publication reuse existing product rules', async () => {
  const { token } = await setup();
  const result = await mapped(token, [dataRow({ SKU: 'M-1' }), dataRow({ SKU: 'M1' }), dataRow({ SKU: 'M-1_1' })]);
  await commit(token, result.batch, result.rows.map(row => row._id));
  const matches = await request(`/api/admin/product-imports/${result.batch._id}/image-matches`, { method: 'POST', token, body: { names: ['M1_1.jpg', 'M-1_1.jpg', 'close-name.jpg'] } });
  assert.equal(matches.data.matches[0].candidates.length, 1); assert.equal(matches.data.matches[0].candidates[0].sku, 'M1');
  assert.equal(matches.data.matches[1].candidates.length, 2); assert.equal(matches.data.matches[2].candidates.length, 0);
  const publish = () => request(`/api/admin/product-imports/${result.batch._id}/publish`, { method: 'POST', token, body: { ids: [result.rows[0]._id], confirm: true } });
  const missing = await publish(); assert.equal(missing.data.success, false); assert.match(missing.data.data.results[0].message, /image/i);
  const images = await request(`/api/admin/product-imports/${result.batch._id}/rows/${result.rows[0]._id}/images`, { method: 'POST', token, body: { images: [{ url: '/uploads/import-watch.webp' }], primaryUrl: '/uploads/import-watch.webp' } });
  assert.equal(images.status, 200, JSON.stringify(images.data));
  const published = await publish(); assert.equal(published.status, 200); assert.equal(published.data.success, true, JSON.stringify(published.data));
  await publish(); assert.equal(await Product.countDocuments(), 1);
  const product = await Product.findOne().lean(); assert.equal(product.stock, 2); assert.equal(product.attributeValues.model, 'F-91W');
});
test('saved supplier profiles retain header identities, configurable synonyms and store scope', async () => {
  const { token } = await setup();
  const saved = await request('/api/admin/product-imports/profiles', { method: 'POST', token, body: { name: 'Supplier A', headers: { Goods: ['Item Description', 'SP'] }, mappings: { Goods: ['name', 'sellingPrice'] }, synonyms: { stock: ['Warehouse Units'] } } });
  assert.equal(saved.status, 200);
  const metadata = await request('/api/admin/product-imports/metadata', { token });
  assert.deepEqual(metadata.data.profiles[0].headers.Goods, ['Item Description', 'SP']);
  const map = await request('/api/admin/product-imports/mapping-suggestions', { method: 'POST', token, body: { headers: ['Warehouse Units', 'Product Type', 'SP'], synonyms: metadata.data.profiles[0].synonyms } });
  assert.equal(map.data.suggestions[0].field, 'stock'); assert.equal(map.data.suggestions[1].field, ''); assert.equal(map.data.suggestions[2].field, 'sellingPrice');
});
test('all 50 new category specifications are discovered and independently validated without importer changes', async () => {
  const { token, category } = await setup();
  await require('../models/Category').updateOne({ _id: category._id }, { $set: { customAttributes: Array.from({ length: 50 }, (_, index) => ({ key: `custom_spec${index}`, label: `Specification ${index}`, type: 'number', required: true, active: true })) } });
  const metadata = await request('/api/admin/product-imports/metadata', { token });
  assert.equal(metadata.data.categories.find(item => item._id === category._id).attributes.filter(item => item.key.startsWith('custom_spec')).length, 50);
  const result = await mapped(token, [dataRow()]);
  assert.equal(result.rows[0].issues.filter(item => item.field.startsWith('attributeValues.custom_spec')).length, 50);
  assert.equal(result.rows[0].state, 'incomplete_draft');
});
test('existing-record enrichment exposes conflicts and provenance without changing commercial data', async () => {
  const { token, category } = await setup();
  const source = await request('/api/admin/products', { method: 'POST', token, body: { name: 'Casio F-91W source', sku: 'SOURCE', category: category._id, price: 999, originalPrice: 2000, stock: 99, warranty: '9 years', images: [{ url: '/uploads/source.webp' }], attributeValues: { brand: 'Casio', model: 'F-91W', condition: 'New', custom_finish: 'Matte', watch_type: 'Digital' } } });
  assert.equal(source.status, 201, JSON.stringify(source.data));
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Products'); sheet.addRow([...headers, 'custom_finish']); sheet.addRow([...dataRow({ SKU: 'DESTINATION' }), 'Gloss']);
  const result = await mapped(token, [], { filename: 'source.xlsx', buffer: Buffer.from(await book.xlsx.writeBuffer()) });
  const response = await request(`/api/admin/product-imports/${result.batch._id}/enrich`, { method: 'POST', token, body: { revision: result.batch.revision, ids: [result.rows[0]._id], allowWeb: false } });
  assert.equal(response.status, 200); await drain(result.batch._id);
  const enriched = await Row.findById(result.rows[0]._id).lean();
  assert.equal(enriched.payload.sellingPrice, 1500); assert.equal(enriched.payload.stock, 2); assert.equal(enriched.payload.warranty, '1 year');
  assert.equal(enriched.payload.attributeValues.custom_finish, 'Gloss'); assert.equal(enriched.state, 'needs_review');
  const index = enriched.provenance.findIndex(item => item.field === 'attributeValues.custom_finish'); assert.ok(index >= 0); assert.equal(enriched.provenance[index].conflict, true);
  assert.equal(enriched.provenance[index].sourceType, 'existing-record'); assert.equal(enriched.provenance[index].verification, 'needs_review');
  const batch = await Batch.findById(result.batch._id).lean();
  const review = await request(`/api/admin/product-imports/${batch._id}/rows`, { method: 'PUT', token, body: { revision: batch.revision, rows: [{ id: enriched._id, values: {}, reviews: enriched.provenance.map((item, index) => ({ index, decision: 'verified' })) }] } });
  assert.equal(review.status, 200); await drain(batch._id);
  const verified = await Row.findById(enriched._id).lean(); assert.equal(verified.payload.attributeValues.custom_finish, 'Matte');
  assert.ok(verified.provenance.every(item => item.verification === 'verified' && item.reviewedBy));
});
test('incomplete enrichment stays reviewable and a wrong source model is never copied', async () => {
  const { token } = await setup();
  const result = await mapped(token, [dataRow()]);
  let response = await request(`/api/admin/product-imports/${result.batch._id}/enrich`, { method: 'POST', token, body: { revision: result.batch.revision, ids: [result.rows[0]._id], allowWeb: false } });
  assert.equal(response.status, 200); await drain(result.batch._id);
  const row = await Row.findById(result.rows[0]._id).lean(); assert.equal(row.state, 'needs_review'); assert.equal(row.provenance.length, 0);
  let batch = await Batch.findById(result.batch._id).lean();
  response = await request(`/api/admin/product-imports/${batch._id}/rows`, { method: 'PUT', token, body: { revision: batch.revision, rows: [{ id: row._id, values: {}, dismissEnrichment: true }] } });
  assert.equal(response.status, 200); await drain(batch._id);
  assert.equal((await Row.findById(row._id)).state, 'incomplete_draft');
});

test('manual source overrides survive rejection and contradictory sources cannot both be verified', async () => {
  const { token } = await setup(); const result = await mapped(token, [dataRow()]); const id = result.rows[0]._id;
  const provenance = ['Matte', 'Gloss'].map(value => ({ field: 'attributeValues.custom_finish', value, previousValue: '', conflict: true, verification: 'needs_review', sourceType: 'cited-web-extraction', sourceUrl: 'https://example.com/specs', extractedAt: new Date() }));
  await Row.updateOne({ _id: id }, { $set: { provenance } });
  let response = await request(`/api/admin/product-imports/${result.batch._id}/rows`, { method: 'PUT', token, body: { revision: result.batch.revision, rows: [{ id, values: {}, reviews: [{ index: 0, decision: 'verified' }, { index: 1, decision: 'verified' }] }] } });
  assert.equal(response.status, 400); await drain(result.batch._id);
  let row = await Row.findById(id).lean(); assert.equal(row.payload.attributeValues.custom_finish, undefined);
  let batch = await Batch.findById(result.batch._id).lean();
  response = await request(`/api/admin/product-imports/${batch._id}/rows`, { method: 'PUT', token, body: { revision: batch.revision, rows: [{ id, values: { 'attributeValues.custom_finish': 'Matte' }, dismissEnrichment: true }] } });
  assert.equal(response.status, 200); await drain(batch._id);
  row = await Row.findById(id).lean(); assert.equal(row.payload.attributeValues.custom_finish, 'Matte'); assert.ok(row.provenance.every(item => item.verification === 'rejected' && item.manualOverride));
  batch = await Batch.findById(batch._id).lean(); assert.equal(batch.lastError, ''); assert.equal(row.state, 'incomplete_draft');
});
test('cancellation and expired processing leases resume without redoing successful rows', async () => {
  const { token } = await setup();
  const result = await mapped(token, [dataRow(), dataRow()]);
  const cancel = await request(`/api/admin/product-imports/${result.batch._id}/cancel`, { method: 'POST', token, body: {} }); assert.equal(cancel.status, 200);
  assert.equal((await Batch.findById(result.batch._id)).status, 'cancelled');
  await Batch.updateOne({ _id: result.batch._id }, { $set: { status: 'queued', job: 'commit', cancelRequested: false, leaseUntil: new Date(Date.now() - 1000), leaseToken: 'dead-process' } });
  await Row.updateMany({ batchId: result.batch._id }, { $set: { approved: true } });
  await drain(result.batch._id);
  assert.equal(await ProductDraft.countDocuments(), 2);
});
test('corrected invalid rows can retry while prior successful drafts retain identity', async () => {
  const { token } = await setup();
  const result = await mapped(token, [dataRow({ SKU: 'VALID' }), dataRow({ SKU: 'CORRECT', SP: 'oops' })]);
  await commit(token, result.batch, [result.rows[0]._id]);
  const batch = await Batch.findById(result.batch._id).lean();
  const edited = await request(`/api/admin/product-imports/${batch._id}/rows`, { method: 'PUT', token, body: { revision: batch.revision, rows: [{ id: result.rows[1]._id, values: { sellingPrice: '1200' } }] } });
  assert.equal(edited.status, 200); await drain(batch._id);
  const corrected = await Row.findById(result.rows[1]._id).lean(); assert.equal(corrected.state, 'incomplete_draft', JSON.stringify(corrected));
  await commit(token, await Batch.findById(batch._id).lean(), [corrected._id]);
  assert.equal(await ProductDraft.countDocuments(), 2); assert.equal(await ProductDraft.countDocuments({ _id: result.rows[0].draftId }), 1);
});
test('stale preview revisions and unselected sheets cannot be silently committed', async () => {
  const { token } = await setup(); const result = await mapped(token, [dataRow()]);
  const stale = await request(`/api/admin/product-imports/${result.batch._id}/commit`, { method: 'POST', token, body: { revision: -1, confirm: true, all: true } }); assert.equal(stale.status, 409);
  const forged = await request(`/api/admin/product-imports/${result.batch._id}/commit`, { method: 'POST', token, body: { revision: result.batch.revision, confirm: false, all: true } }); assert.equal(forged.status, 400);
});
test('existing variant updates retain stable ids, other variants and per-variant inventory', async () => {
  const { token, category } = await setup();
  const created = await request('/api/admin/products', { method: 'POST', token, body: { name: 'Casio F-91W', sku: 'VARIANT-PARENT', category: category._id, price: 1500, originalPrice: 2000, stock: 7, images: [{ url: '/uploads/watch.webp' }], attributeValues: { brand: 'Casio', model: 'F-91W', condition: 'New' }, variants: [{ sku: 'VP-BLACK', optionValues: { colour: 'Black' }, stock: 3, price: 1500 }, { sku: 'VP-SILVER', optionValues: { colour: 'Silver' }, stock: 4, price: 1600 }] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.variants?.length, 2, JSON.stringify(created.data));
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Products'); sheet.addRow([...headers, 'Variants']); sheet.addRow([...dataRow({ SKU: 'VARIANT-PARENT' }), JSON.stringify([{ sku: 'VP-BLACK', optionValues: { colour: 'Black' }, price: 1400, stock: 6 }])]);
  const result = await mapped(token, [], { filename: 'update-variant.xlsx', buffer: Buffer.from(await book.xlsx.writeBuffer()), mode: 'update', updateFields: ['variants', 'price', 'stock'] });
  assert.equal(result.rows[0].state, 'ready', JSON.stringify(result.rows[0]));
  await commit(token, result.batch, [result.rows[0]._id]);
  const product = await Product.findById(created.data._id).lean(); assert.equal(product.variants.length, 2, JSON.stringify(await Row.findById(result.rows[0]._id).lean())); assert.equal(String(product.variants[0]._id), created.data.variants[0]._id); assert.equal(product.variants[0].stock, 6); assert.equal(product.variants[0].price, 1400); assert.equal(product.variants[1].stock, 4); assert.equal(product.stock, 10);
  const image = await request(`/api/admin/product-imports/${result.batch._id}/rows/${result.rows[0]._id}/images`, { method: 'POST', token, body: { variantSku: 'VP-SILVER', images: [{ url: '/uploads/silver-side.webp' }], primaryUrl: '/uploads/silver-side.webp' } });
  assert.equal(image.status, 200, JSON.stringify(image.data));
  const refreshed = await Product.findById(product._id).lean(); assert.equal(refreshed.images[0].url, '/uploads/watch.webp'); assert.equal(refreshed.variants[1].images[0].url, '/uploads/silver-side.webp'); assert.equal(refreshed.stock, 10);
  const preview = await request(`/api/admin/product-imports/${result.batch._id}/rows?imageManager=true`, { token }); assert.equal(preview.data.items[0].draft.images.length, 1); assert.equal(preview.data.items[0].draft.variants[1].images.length, 1);
});
test('foreign-store batch ids and explicit product identifiers cannot change another store', async () => {
  const { token } = await setup();
  const store = await require('../models/Store').create({ name: 'Another store', slug: 'another-store', status: 'PUBLISHED' });
  const foreignBatch = await Batch.create({ storeId: store._id, fileName: 'foreign.csv' });
  assert.equal((await request(`/api/admin/product-imports/${foreignBatch._id}`, { token })).status, 404);
  const foreign = await Product.create({ storeId: store._id, name: 'Other store watch', slug: 'other-watch', sku: 'OTHER-TENANT', price: 100, originalPrice: 200, stock: 7 });
  const result = await mapped(token, [dataRow({ SKU: 'OTHER-TENANT' })], { mode: 'update', updateFields: ['price'] });
  assert.equal(result.rows[0].state, 'invalid'); assert.equal((await Product.findById(foreign._id)).price, 100);
});
test('choosing a source with a different exact model cannot fill its specifications', async () => {
  const { token, category } = await setup();
  const source = await Product.create({ name: 'Different model', slug: 'different-model', sku: 'OTHER-MODEL', category: category._id, price: 1000, originalPrice: 2000, stock: 1, attributeValues: { brand: 'Casio', model: 'AE-1200', custom_finish: 'Matte' } });
  const result = await mapped(token, [dataRow()]);
  const changed = await request(`/api/admin/product-imports/${result.batch._id}/rows`, { method: 'PUT', token, body: { revision: result.batch.revision, rows: [{ id: result.rows[0]._id, values: {}, sourceId: String(source._id) }] } });
  assert.equal(changed.status, 200); await drain(result.batch._id);
  const row = await Row.findById(result.rows[0]._id).lean(); assert.equal(row.state, 'needs_review'); assert.equal(row.payload.attributeValues.custom_finish, undefined); assert.equal(row.provenance.length, 0);
});

test('one hundred smartphone parents retain configured memory, technical specs and independent variant inventory', async () => {
  const { token } = await setup();
  const category = await request('/api/admin/categories', { method: 'POST', token, body: { name: 'Smartphones', slug: 'smartphones', definitionKey: 'smartphones' } }); assert.equal(category.status, 201);
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Products'); sheet.addRow([...headers, 'Product Attributes', 'Variants']);
  for (let i = 0; i < 100; i++) sheet.addRow([...dataRow({ 'Product Name': `TestPhone P${i}`, Category: 'Smartphones', Brand: 'TestPhone', Model: `P${i}`, SKU: `PHONE-${i}` }), JSON.stringify({ processor: `Test chipset ${i}`, battery: 5000 + i, ram: i % 2 ? '12' : '8', storage: i % 2 ? '256' : '128' }), JSON.stringify([{ sku: `PHONE-${i}-128`, optionValues: { ram: '8', storage: '128', colour: 'Black' }, price: 1500, originalPrice: 2000, stock: 2 }, { sku: `PHONE-${i}-256`, optionValues: { ram: '12', storage: '256', colour: 'Silver' }, price: 1700, originalPrice: 2200, stock: 3 }])]);
  const result = await mapped(token, [], { filename: '100-smartphones.xlsx', buffer: Buffer.from(await book.xlsx.writeBuffer()) });
  assert.equal(result.rows.length, 100); assert.ok(result.rows.every(row => row.state === 'incomplete_draft'), JSON.stringify(result.rows.find(row => row.state !== 'incomplete_draft')));
  const done = await commit(token, result.batch, result.rows.map(row => row._id)); assert.equal(done.summary.created_draft, 100);
  const drafts = await ProductDraft.find({ sourceImportBatchId: result.batch._id }).lean();
  assert.equal(drafts.length, 100); assert.ok(drafts.every(draft => draft.variants.length === 2 && draft.stock === 5 && draft.variants[1].price === 1700 && draft.variants[0].stock === 2));
  assert.equal(drafts.find(draft => draft.sku === 'PHONE-99').attributeValues.battery, '5099');
  assert.equal(await Product.countDocuments(), 0);
});

test('a single mixed workbook validates six category schemas independently and imports them into existing drafts', async () => {
  const { token } = await setup();
  const categories = [
    ['Mobile phones', 'smartphones', { processor: 'Test chipset', ram: '8', storage: '256' }],
    ['TVs', 'televisions', { screen_size: '43' }],
    ['Laundry', 'washing_machines', { wash_capacity: '7' }],
    ['Speakers', 'speakers', { output_power: '20' }],
    ['Smartwatches', 'smart_watches', { compatible_os: 'Android, iOS' }],
    ['Earbuds', 'earphones', { earphone_type: 'True wireless', connectivity: 'Bluetooth' }],
  ];
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Mixed supplier'); sheet.addRow([...headers, 'Product Attributes']);
  for (const [index, [name, definitionKey, attributes]] of categories.entries()) {
    const created = await request('/api/admin/categories', { method: 'POST', token, body: { name, slug: `mixed-${index}`, definitionKey } }); assert.equal(created.status, 201, JSON.stringify(created.data));
    sheet.addRow([...dataRow({ Category: name, 'Product Name': `TestBrand Model ${index}`, Brand: 'TestBrand', Model: `Model ${index}`, SKU: `MIXED-${index}` }), JSON.stringify(attributes)]);
  }
  const result = await mapped(token, [], { filename: 'six-categories.xlsx', buffer: Buffer.from(await book.xlsx.writeBuffer()) });
  assert.ok(result.rows.every(row => row.state === 'incomplete_draft'), JSON.stringify(result.rows));
  assert.ok(result.rows.every(row => row.issues.every(issue => issue.field === 'images')), JSON.stringify(result.rows));
  await commit(token, result.batch, result.rows.map(row => row._id));
  const drafts = await ProductDraft.find({ sourceImportBatchId: result.batch._id }).lean(); assert.equal(drafts.length, 6);
  assert.equal(drafts.find(draft => draft.sku === 'MIXED-1').attributeValues.screen_size, '43');
  assert.equal(drafts.find(draft => draft.sku === 'MIXED-2').attributeValues.wash_capacity, '7');
  assert.equal(drafts.find(draft => draft.sku === 'MIXED-1').attributeValues.ram, undefined);
});
