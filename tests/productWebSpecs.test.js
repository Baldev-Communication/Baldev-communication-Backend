const test = require('node:test');
const assert = require('node:assert/strict');
const { modelIdentity, normalizeGroundedSpecs, researchProductSpecs } = require('../services/productWebSpecs.service');

const attributes = [
  { key: 'model', label: 'Model', type: 'text' },
  { key: 'ram', label: 'RAM', type: 'dropdown', options: ['4', '6', '8'], unit: 'GB' },
  { key: 'storage', label: 'Storage', type: 'dropdown', options: ['64', '128', '256'], unit: 'GB' },
  { key: 'processor', label: 'Processor', type: 'text' },
  { key: 'dimensions', label: 'Dimensions', type: 'text' },
  { key: 'display_size', label: 'Display size', type: 'measurement', unit: 'in' },
  { key: 'battery', label: 'Battery', type: 'measurement', unit: 'mAh' },
  { key: 'condition', label: 'Condition', type: 'text' },
];
const uri = 'https://example.com/galaxy-a15';

test('Smart Fill includes category-specific mobile attributes', () => {
  const { configuredAttributes } = require('../controllers/productSmartFillController');
  const selected = configuredAttributes({ attributes: [{ key: 'condition', label: 'Condition' }], categoryDefinitions: [
    { key: 'smartphones', name: 'Smartphones', attributes: [{ key: 'processor', label: 'Processor' }, { key: 'ram', label: 'RAM' }] },
  ] }, [{ _id: 'category-id', name: 'Smartphones', definitionKey: 'smartphones' }], { category: 'category-id' });
  assert.deepEqual(selected.map(item => item.key), ['condition', 'processor', 'ram']);
});

function grounded(lines, cited = lines.map((_, index) => index)) {
  const text = lines.join('\n'); let start = 0;
  const supports = lines.flatMap((line, index) => {
    const segment = { startIndex: start, endIndex: start + line.length, text: line };
    start += line.length + 1;
    return cited.includes(index) ? [{ segment, groundingChunkIndices: [0] }] : [];
  });
  return { text, groundingMetadata: { groundingChunks: [{ web: { uri, title: 'Manufacturer specs' } }], groundingSupports: supports } };
}

test('model and GB variant come from configured form attributes', () => {
  assert.deepEqual(modelIdentity({ existing: { name: 'Samsung Galaxy A15', attributeValues: { model: 'Galaxy A15 5G', ram: '8', storage: '128' } }, attributes }), { model: 'Galaxy A15 5G', ram: '8', storage: '128' });
  assert.deepEqual(modelIdentity({ existing: { name: 'Samsung Galaxy A15 5G 8/128GB' }, attributes }), { model: 'Samsung Galaxy A15 5G', ram: '8', storage: '128' });
  assert.deepEqual(modelIdentity({ existing: { name: 'Apple iPhone 17 256', attributeValues: { storage: '256' } }, attributes }), { model: 'Apple iPhone 17', ram: '', storage: '256' });
  assert.deepEqual(modelIdentity({ caption: 'Model: Galaxy A15 5G 8GB/128GB', attributes }), { model: 'Galaxy A15 5G', ram: '8', storage: '128' });
  assert.equal(modelIdentity({ existing: { name: 'Cotton Saree' }, attributes: [{ key: 'model' }] }), null);
});

test('only individually cited facts for the verified model and GB variant become suggestions', () => {
  const raw = grounded(['model: Samsung Galaxy A15 5G', 'brand: Samsung', 'ram: 8 GB', 'storage: 128 GB', 'processor: Dimensity 6100+', 'battery: 5000 mAh', 'display_size: 6.5 inches', 'dimensions: 160.1 x 76.8 x 8.4 mm', 'condition: New', 'rear_camera: 50 MP'], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const result = normalizeGroundedSpecs(raw, { model: 'Galaxy A15 5G', ram: '8', storage: '128' }, attributes);
  assert.equal(result.suggestion.brand, 'Samsung');
  assert.equal(result.suggestion.attributeValues.ram, '8');
  assert.equal(result.suggestion.attributeValues.storage, '128');
  assert.equal(result.suggestion.attributeValues.processor, 'Dimensity 6100+');
  assert.equal(result.suggestion.attributeValues.battery, '5000');
  assert.equal(result.suggestion.attributeValues.display_size, '6.5');
  assert.equal(result.suggestion.attributeValues.dimensions, '160.1 x 76.8 x 8.4 mm');
  assert.equal(result.suggestion.attributeValues.condition, undefined);
  assert.equal(result.suggestion.attributeValues.rear_camera, undefined);
  assert.equal(result.fieldSources['attribute.processor'].url, uri);
  assert.deepEqual(result.sources, [{ url: uri, title: 'Manufacturer specs' }]);
});

test('uncited identity or mismatched capacity blocks the entire web result', () => {
  const lines = ['model: Samsung Galaxy A15 5G', 'ram: 6 GB', 'storage: 128 GB', 'processor: Wrong chip'];
  const identity = { model: 'Galaxy A15 5G', ram: '8', storage: '128' };
  assert.deepEqual(normalizeGroundedSpecs(grounded(lines, [1, 2, 3]), identity, attributes).suggestion, {});
  assert.deepEqual(normalizeGroundedSpecs(grounded(lines), identity, attributes).suggestion, {});
  assert.deepEqual(normalizeGroundedSpecs(grounded(['model: Samsung Galaxy A15 5G', 'processor: Chip'], [0]), identity, attributes).suggestion, {});
});

test('cited manufacturer brand can prefix an exact model without mixing Pro variants', () => {
  const iphone = { model: 'Apple iPhone 17', ram: '', storage: '256' };
  const exact = normalizeGroundedSpecs(grounded(['model: iPhone 17', 'brand: Apple', 'storage: 256 GB', 'processor: A19']), iphone, attributes);
  assert.equal(exact.suggestion.attributeValues.processor, 'A19');
  const wrong = normalizeGroundedSpecs(grounded(['model: iPhone 17 Pro', 'brand: Apple', 'storage: 256 GB', 'processor: A19 Pro']), iphone, attributes);
  assert.deepEqual(wrong.suggestion, {});
});

test('web lookup requests Google Search grounding and excludes unsupported sales claims', async (t) => {
  const previous = { key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
  process.env.GEMINI_API_KEY = 'synthetic-web-spec-key'; process.env.GEMINI_MODEL = 'gemini-flash-latest';
  t.after(() => { for (const [key, value] of Object.entries({ GEMINI_API_KEY: previous.key, GEMINI_MODEL: previous.model })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  t.mock.method(global, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.tools, [{ google_search: {} }]);
    assert.equal(body.generationConfig.responseMimeType, undefined);
    assert.match(body.contents[0].parts[0].text, /Galaxy A15 5G/);
    const raw = grounded(['model: Samsung Galaxy A15 5G', 'ram: 8 GB', 'storage: 128 GB', 'processor: Dimensity 6100+']);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: raw.text }] }, groundingMetadata: raw.groundingMetadata }] }) };
  });
  const result = await researchProductSpecs({ identity: { model: 'Galaxy A15 5G', ram: '8', storage: '128' }, attributes });
  assert.equal(result.suggestion.attributeValues.processor, 'Dimensity 6100+');
});

test('AI identified phone category unlocks grounded mobile specs without creating product records', async (t) => {
  const { EventEmitter } = require('node:events');
  const Category = require('../models/Category');
  const Configuration = require('../models/MasterConfiguration');
  const Product = require('../models/Product');
  const controller = require('../controllers/productSmartFillController');
  const previous = { key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
  process.env.GEMINI_API_KEY = 'synthetic-controller-web-key'; process.env.GEMINI_MODEL = 'gemini-flash-latest';
  t.after(() => { for (const [key, value] of Object.entries({ GEMINI_API_KEY: previous.key, GEMINI_MODEL: previous.model })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const phoneId = '0123456789abcdef01234567';
  t.mock.method(Category, 'find', () => ({ select() { return this; }, limit() { return this; }, lean: async () => [{ _id: phoneId, name: 'Smartphones', definitionKey: 'smartphones' }] }));
  t.mock.method(Configuration, 'findById', () => ({ lean: async () => ({ structure: { features: {}, attributes: attributes.filter(item => ['model', 'dimensions'].includes(item.key)), categoryDefinitions: [{ key: 'smartphones', name: 'Smartphones', attributes: attributes.filter(item => ['ram', 'storage', 'processor', 'battery'].includes(item.key)) }] } }) }));
  const write = t.mock.method(Product, 'create', () => { throw new Error('Do not save a product'); });
  const web = grounded(['model: Samsung Galaxy A15 5G', 'ram: 8 GB', 'storage: 128 GB', 'processor: Dimensity 6100+', 'battery: 5000 mAh', 'dimensions: 160.1 x 76.8 x 8.4 mm']);
  let calls = 0;
  t.mock.method(global, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    calls++;
    if (body.tools) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: web.text }] }, groundingMetadata: web.groundingMetadata }] }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ name: 'Samsung Galaxy A15 5G', category: phoneId, description: '', shortDescription: '', multipleProducts: false, priceAmbiguous: false, fieldSources: {}, attributeValues: {} }) }] } }] }) };
  });
  const response = new EventEmitter(); response.json = value => { response.body = value; response.writableEnded = true; };
  let error;
  await controller.fill({ user: { _id: 'web-admin' }, tenantFilter: { storeId: 'test-store' }, body: { notes: 'Model: Galaxy A15 5G', imageUrls: [], existing: { name: 'Samsung Galaxy A15 5G', attributeValues: { model: 'Galaxy A15 5G', ram: '8', storage: '128' } } } }, response, value => { error = value; });
  assert.equal(error, undefined);
  assert.equal(response.body.mode, 'web');
  assert.equal(response.body.suggestion.attributeValues.processor, 'Dimensity 6100+');
  assert.equal(response.body.suggestion.attributeValues.battery, '5000');
  assert.equal(response.body.suggestion.attributeValues.dimensions, '160.1 x 76.8 x 8.4 mm');
  assert.equal(response.body.suggestion.price, undefined);
  assert.equal(response.body.webSources[0].url, uri);
  assert.equal(calls, 2);
  assert.equal(write.mock.callCount(), 0);
});
