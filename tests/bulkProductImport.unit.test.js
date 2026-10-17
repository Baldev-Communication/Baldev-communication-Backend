const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parse, inspectZip, csvRows, toCsv } = require('../modules/bulk-product-import/spreadsheet');
const { autoMap, definitions } = require('../modules/bulk-product-import/fields');
const { number, safe, patchForUpdate, categoryMatch, mapRow } = require('../modules/bulk-product-import/validation');
const { sameVariant } = require('../modules/bulk-product-import/enrichment');
test('CSV accepts quoted delimiters, newlines, BOM and exact literal commercial amounts', async () => {
  const sheets = await parse(Buffer.from('\uFEFFName;SP;Notes\r\n"TV; panel";"₹32,999";"line 1\nline 2"\r\n'), 'supplier.csv');
  assert.deepEqual(sheets[0].headers, ['Name', 'SP', 'Notes']); assert.equal(sheets[0].rows[0].raw[0], 'TV; panel');
  assert.equal(number('₹32,999', true), 32999); assert.equal(number('1,23,456.78', true), 123456.78);
  assert.deepEqual(csvRows('"Item, description";Price\nWatch;20')[0], ['Item, description', 'Price']);
  assert.ok(Number.isNaN(number('USD 300', true))); assert.ok(Number.isNaN(number('1,2,3', true)));
});
test('ambiguous aliases stay unmapped and configured supplier synonyms remain suggestions', () => {
  const fields = [...definitions, { key: 'attributeValues.size', label: 'Dimension', aliases: ['Size'] }, { key: 'attributeValues.screen_size', label: 'Screen', aliases: ['Size'] }];
  const result = autoMap(['SP', 'Available Units', 'SIZE', 'Unknown', 'Product Type'], fields);
  assert.equal(result[0].field, 'sellingPrice'); assert.equal(result[1].field, 'stock'); assert.equal(result[2].field, ''); assert.equal(result[2].candidates.length, 2); assert.equal(result[4].field, '');
});
test('CSV result exports neutralize formulas including leading control characters', () => {
  const csv = toCsv([['=HYPERLINK("https://example.test")', '+cmd', '-1', '@SUM(A1)', '\t=1+1', 'ordinary']]);
  assert.ok(csv.includes('"\'=HYPERLINK')); assert.ok(csv.includes('"\'+cmd"')); assert.ok(csv.includes('"\'-1"')); assert.ok(csv.includes('"\'@SUM')); assert.ok(csv.includes('"\'\t=1+1"')); assert.ok(csv.includes('"ordinary"'));
});
test('JSON content cannot introduce prototype, database operators, dotted keys or excessive nesting', () => {
  for (const value of ['{"__proto__":{"polluted":true}}', '{"$set":1}', '{"a.b":1}', '{"constructor":{}}']) assert.throws(() => safe(JSON.parse(value)));
  let deep = {}; for (let i = 0; i < 10; i++) deep = { a: deep }; assert.throws(() => safe(deep)); assert.equal({}.polluted, undefined);
});
test('blank cells, unapproved prices and images never replace unrelated product data', () => {
  const existing = { price: 100, originalPrice: 200, stock: 5, warranty: '1 year', images: [{ url: 'https://example.test/image' }], attributeValues: { brand: 'Brand', processor: 'Chip' } };
  const patch = patchForUpdate({ sellingPrice: 99, originalPrice: '', stock: 0, warranty: '', images: [] }, existing, ['stock', 'warranty', 'originalPrice']);
  assert.deepEqual(patch, { stock: 0 });
  assert.deepEqual(patchForUpdate({}, existing, ['warranty'], ['warranty']), { warranty: '' });
  assert.deepEqual(patchForUpdate({ attributeValues: { brand: '', processor: '' } }, existing, ['attributeValues']).attributeValues, existing.attributeValues);
});
test('variant updates preserve ids, gallery and untouched stock when only prices are allowed', () => {
  const existing = { variants: [{ _id: 'stable', sku: 'V-1', optionValues: { colour: 'Black' }, price: 100, stock: 8, images: [{ url: '/uploads/old.webp' }] }, { _id: 'other', sku: 'V1', optionValues: { colour: 'Silver' }, price: 120, stock: 5 }] };
  const patch = patchForUpdate({ variants: [{ sku: 'V-1', price: 99, stock: 0, images: [] }] }, existing, ['variants', 'price']);
  assert.equal(patch.variants[0]._id, 'stable'); assert.equal(patch.variants[0].stock, 8); assert.equal(patch.variants[0].price, 99); assert.equal(patch.variants[0].images.length, 1); assert.equal(patch.variants[1].price, 120);
  const availability = patchForUpdate({ variants: [{ sku: 'V-1', optionValues: { colour: '' }, isActive: false }] }, existing, ['variants']);
  assert.equal(availability.variants[0].isActive, false); assert.equal(availability.variants[0].optionValues.colour, 'Black');
});
test('exact variant and regional identities are required before source details can be used', () => {
  assert.equal(sameVariant({ ram: '8', storage: '256' }, { ram: '8', storage: '128' }), false);
  assert.equal(sameVariant({ region: 'India' }, { region: 'US' }), false);
  assert.equal(sameVariant({ custom_region: 'India' }, { custom_region: 'US' }), false);
  assert.equal(sameVariant({ model_number: 'A2890' }, {}), false);
  assert.equal(sameVariant({ ram: '8', storage: '256', region: 'India' }, { ram: '8', storage: '256', region: 'India' }), true);
});
test('category aliases, normalized paths and manual mappings do not choose among duplicate names', () => {
  const context = { structure: { categoryDefinitions: [{ key: 'mobile', aliases: ['cellphone'] }] }, categories: [{ _id: 'a', name: 'Phones', path: 'Electronics / Phones', slug: 'phones', definitionKey: 'mobile' }, { _id: 'b', name: 'Phones', path: 'Accessories / Phones', slug: 'accessories-phones' }] };
  assert.equal(categoryMatch('Phones', '', context).category, null);
  assert.equal(categoryMatch('ELECTRONICS / PHONES', '', context).category._id, 'a');
  assert.equal(categoryMatch('cellphone', '', context).category._id, 'a');
  assert.equal(categoryMatch('Supplier Group', '', context, { suppliergroup: 'b' }).category._id, 'b');
});
test('archive entry metadata is verified against actual bounded decompression', async () => {
  const book = new ExcelJS.Workbook(); book.addWorksheet('Products').addRow(['Name']);
  const bytes = Buffer.from(await book.xlsx.writeBuffer()); assert.doesNotThrow(() => inspectZip(bytes));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const forged = Buffer.from(bytes); forged.writeUInt32LE(1, central + 24); assert.throws(() => inspectZip(forged), /expanded size/);
  assert.throws(() => csvRows('Name,Price\n"unclosed,20'), /unclosed/);
});
test('structured attributes and individual columns preserve compatible values and expose conflicting sources', () => {
  const valid = mapRow({ raw: ['{"brand":"Brand","model":"Exact"}', 'Exact'] }, ['attributeValues', 'attributeValues.model']);
  assert.equal(valid.payload.attributeValues.brand, 'Brand'); assert.equal(valid.issues.length, 0);
  const conflict = mapRow({ raw: ['{"model":"Exact"}', 'Different'] }, ['attributeValues', 'attributeValues.model']);
  assert.match(conflict.issues[0].message, /conflict/); assert.equal(conflict.payload.attributeValues.model, 'Exact');
  const reverse = mapRow({ raw: ['Exact', '{"model":"Different"}'] }, ['attributeValues.model', 'attributeValues']);
  assert.match(reverse.issues[0].message, /conflict/); assert.equal(reverse.payload.attributeValues.model, 'Exact');
});

test('conflicting grounded web facts are exposed for review without staging an arbitrary value', async t => {
  const Product = require('../models/Product');
  const { enrich, commercial } = require('../modules/bulk-product-import/enrichment');
  t.mock.method(Product, 'find', () => ({ select() { return this; }, limit() { return this; }, lean: async () => [] }));
  const previous = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'synthetic-import-test';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  const text = 'model: Samsung Galaxy A15\nbrand: Samsung\nprocessor: Chip A\nprocessor: Chip B';
  let offset = 0;
  const groundingSupports = text.split('\n').map(line => { const segment = { startIndex: offset, endIndex: offset + line.length, text: line }; offset += line.length + 1; return { segment, groundingChunkIndices: [0] }; });
  t.mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/specifications', title: 'Specs' } }], groundingSupports } }] }) }));
  const result = await enrich({ payload: { name: 'Samsung Galaxy A15', brand: 'Samsung', sellingPrice: 1234, stock: 3, attributeValues: { model: 'Samsung Galaxy A15' } }, provenance: [] }, { allowWeb: true, provider: 'gemini' }, { scope: {}, categories: [], structure: { attributes: [{ key: 'model', type: 'text' }, { key: 'processor', label: 'Processor', type: 'text' }], categoryDefinitions: [] } });
  assert.equal(result.warning, ''); assert.equal(result.payload.attributeValues.processor, undefined);
  assert.equal(result.payload.sellingPrice, 1234); assert.equal(result.payload.stock, 3);
  assert.deepEqual(result.provenance.map(item => item.value), ['Chip A', 'Chip B']);
  assert.ok(result.provenance.every(item => item.conflict && item.verification === 'needs_review' && item.sourceUrl));
  assert.equal(commercial({ key: 'custom_purchase_amount', label: 'Purchase price' }), true);
});
