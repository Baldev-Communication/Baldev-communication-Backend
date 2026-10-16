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
    const length = Buffer.byteLength(line, 'utf8');
    const segment = { startIndex: start, endIndex: start + length, text: line };
    start += length + 1;
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
  assert.deepEqual(modelIdentity({ existing: { name: 'Apple iPhone 17 256' }, attributes: [{ key: 'model' }] }), { model: 'Apple iPhone 17', ram: '', storage: '256' });
  assert.deepEqual(modelIdentity({ existing: { name: 'Apple iPhone 17 256' }, suggestion: { attributeValues: { model: 'iPhone 17' } }, attributes }), { model: 'iPhone 17', ram: '', storage: '256' });
  assert.deepEqual(modelIdentity({ existing: { name: 'Apple iPhone 17 1TB' }, attributes: [{ key: 'model' }] }), { model: 'Apple iPhone 17', ram: '', storage: '1024' });
  assert.deepEqual(modelIdentity({ existing: { name: 'Samsung Galaxy A15 5G 8/128' }, attributes: [{ key: 'model' }] }), { model: 'Samsung Galaxy A15 5G', ram: '8', storage: '128' });
  assert.equal(modelIdentity({ existing: { name: 'iPhone 17 case', attributeValues: { model: 'iPhone 17' } }, attributes }), null);
  assert.deepEqual(modelIdentity({ existing: { name: 'Iphn 15 128 GB', attributeValues: { storage: '128 GB' } }, attributes }), { model: 'iPhone 15', ram: '', storage: '128' });
  assert.deepEqual(modelIdentity({ existing: { name: 'Galaxy A15 5G', attributeValues: { ram: '8 GB', storage: '0.25 TB' } }, attributes }), { model: 'Galaxy A15 5G', ram: '8', storage: '256' });
});

test('exact accessory models use their configured specifications without borrowing phone specs', () => {
  const configured = [{ key: 'model', type: 'text' }, { key: 'charger_type', type: 'dropdown' }, { key: 'output_power', type: 'measurement', unit: 'W' }];
  assert.deepEqual(modelIdentity({ existing: { name: 'Samsung 25W USB-C Charger', attributeValues: { model: 'EP-T2510', brand: 'Samsung' } }, attributes: configured }), { model: 'EP-T2510', ram: '', storage: '', kind: 'electronics' });
  assert.deepEqual(modelIdentity({ existing: { name: 'Apple 20W USB-C Power Adapter' }, attributes: configured }), { model: 'Apple 20W USB-C Power Adapter', ram: '', storage: '', kind: 'electronics' });
  assert.equal(modelIdentity({ existing: { name: 'iPhone 15 case' }, attributes: [{ key: 'model' }, { key: 'case_type' }] }), null);
  assert.equal(modelIdentity({ existing: { name: 'charger' }, attributes: configured }), null);
  const result = normalizeGroundedSpecs(grounded(['model: Samsung EP-T2510', 'brand: Samsung', 'charger_type: Wall charger', 'output_power: 25 W', 'battery: 5000 mAh']), { model: 'EP-T2510', ram: '', storage: '', kind: 'electronics' }, configured);
  assert.equal(result.suggestion.attributeValues.output_power, '25');
  assert.equal(result.suggestion.attributeValues.battery, undefined);
});

test('common phone families and RAM/ROM title formats reach the exact-model lookup', () => {
  const basic = [{ key: 'model' }, { key: 'brand' }];
  for (const [name, model, ram, storage] of [
    ['Samsung Galaxy A15 5G 8 GB RAM + 128 GB Storage', 'Samsung Galaxy A15 5G', '8', '128'],
    ['Samsung Galaxy Z Fold6 256 GB', 'Samsung Galaxy Z Fold6', '', '256'],
    ['Samsung Galaxy Z Flip 6 256GB', 'Samsung Galaxy Z Flip 6', '', '256'],
    ['OnePlus Nord CE4 8GB/128GB', 'OnePlus Nord CE4', '8', '128'],
    ['OPPO Reno12 5G 8GB 256GB', 'OPPO Reno12 5G', '8', '256'],
    ['Nothing Phone (2a) 8GB/128GB', 'Nothing Phone (2a)', '8', '128'],
    ['Realme GT 6 12 GB RAM 256 GB ROM', 'Realme GT 6', '12', '256'],
    ['Samsung Galaxy S24+ (RAM: 8 GB / Storage: 256 GB)', 'Samsung Galaxy S24+', '8', '256'],
  ]) assert.deepEqual(modelIdentity({ existing: { name }, attributes: basic }), { model, ram, storage }, name);
  assert.equal(modelIdentity({ existing: { name: 'case for OnePlus Nord CE4' }, attributes: basic }), null);
});

test('Plus model suffixes cannot verify the regular model', () => {
  const raw = grounded(['model: Samsung Galaxy S24', 'processor: Chip']);
  assert.deepEqual(normalizeGroundedSpecs(raw, { model: 'Samsung Galaxy S24+' }, attributes).suggestion, {});
  assert.equal(normalizeGroundedSpecs(grounded(['model: Samsung Galaxy S24 Plus', 'processor: Chip']), { model: 'Samsung Galaxy S24+' }, attributes).suggestion.attributeValues.processor, 'Chip');
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

test('verified phone facts form a usable description while unknown RAM and storage remain blank', () => {
  const result = normalizeGroundedSpecs(grounded([
    'model: Samsung Galaxy A15 5G', 'brand: Samsung', 'ram: 8 GB', 'storage: 128 GB',
    'processor: Dimensity 6100+', 'display_size: 6.5 inches', 'battery: 5000 mAh',
    'dimensions: 160.1 x 76.8 x 8.4 mm',
  ]), { model: 'Galaxy A15 5G', ram: '', storage: '' }, attributes);
  assert.equal(result.suggestion.attributeValues.ram, undefined);
  assert.equal(result.suggestion.attributeValues.storage, undefined);
  assert.match(result.suggestion.description, /Processor: Dimensity 6100\+/);
  assert.match(result.suggestion.description, /Display size: 6.5 in/);
  assert.match(result.suggestion.description, /Dimensions: 160.1 x 76.8 x 8.4 mm/);
  assert.equal(result.suggestion.packageDimensions, undefined);
  assert.equal(result.suggestion.shippingWeightKg, undefined);
  assert.equal(result.fieldSources.description.source, 'web');
});

test('a model-wide RAM capacity fills from the phone name without choosing among variants', () => {
  const single = normalizeGroundedSpecs(grounded(['model: iPhone 15', 'brand: Apple', 'ram_options: 6 GB', 'storage_options: 128 GB, 256 GB, 512 GB']), { model: 'Iphn 15', ram: '', storage: '128' }, attributes);
  assert.equal(single.suggestion.attributeValues.ram, '6');
  assert.equal(single.suggestion.attributeValues.storage, '128');
  assert.match(single.suggestion.name, /^Apple iPhone 15 128 GB$/);
  const multiple = normalizeGroundedSpecs(grounded(['model: Galaxy A15 5G', 'ram_options: 4 GB, 6 GB, 8 GB', 'storage: 128 GB']), { model: 'Galaxy A15 5G', ram: '', storage: '128' }, attributes);
  assert.equal(multiple.suggestion.attributeValues.ram, undefined);
});

test('all configured technical fields and reviewed manufacturer information survive normalization', () => {
  const { DEFAULT_STRUCTURE } = require('../config/industryPresets');
  const { configuredAttributes } = require('../services/productAttributes');
  const configured = configuredAttributes(DEFAULT_STRUCTURE, [{ _id: 'phone', definitionKey: 'smartphones' }], { category: 'phone' });
  const facts = {
    model: 'iPhone 15', brand: 'Apple', ram_options: '6 GB', storage: '128 GB', processor: 'A16 Bionic',
    cpu_details: '6-core CPU, 5-core GPU', display_size: '6.1 inches', display_type: 'OLED', display_resolution: '2556 x 1179',
    refresh_rate: '60 Hz', display_protection: 'Ceramic Shield', battery: '3349 mAh', charging_power: '20 W', wireless_charging: 'Yes',
    rear_camera: '48 MP + 12 MP', front_camera: '12 MP', camera_features: 'Night mode', video_recording: '4K at 60 fps',
    operating_system: 'iOS', os_version: 'iOS 17 at launch', network_type: '5G', network_bands: 'Sub-6 GHz', sim_type: 'Dual SIM + eSIM',
    wifi: 'Wi-Fi 6', bluetooth: '5.3', nfc: 'Yes', usb: 'USB-C', gps: 'Yes', expandable_storage: 'Not supported',
    ip_rating: 'IP68', security_features: 'Face ID', sensors: 'Accelerometer, gyro', dimensions: '147.6 x 71.6 x 7.8 mm', weight: '171 g',
    manufacturer: 'Apple Inc.', warranty: '1 year limited warranty', warranty_type: 'Manufacturer', warranty_terms: 'Standard manufacturer terms', box_contents: 'Phone, USB-C cable',
    condition: 'New', country_of_origin: 'India', sar_value: '1.0 W/kg', regulatory_certification: 'Example certificate',
  };
  const result = normalizeGroundedSpecs(grounded(Object.entries(facts).map(([key, value]) => `${key}: ${value}`)), { model: 'Apple iPhone 15', ram: '', storage: '128' }, configured);
  assert.equal(Object.keys(result.suggestion.attributeValues).length, 39);
  assert.equal(result.suggestion.attributeValues.display_type, 'OLED');
  assert.equal(result.suggestion.attributeValues.weight, '171');
  assert.equal(result.suggestion.attributeValues.manufacturer, 'Apple Inc.');
  assert.equal(result.suggestion.attributeValues.cpu_details, facts.cpu_details);
  assert.equal(result.suggestion.attributeValues.sensors, facts.sensors);
  assert.equal(result.fieldSources['attribute.warranty'].reviewRequired, true);
  assert.equal(result.fieldSources['attribute.box_contents'].reviewRequired, true);
  assert.doesNotMatch(result.suggestion.description, /limited warranty|USB-C cable/);
  for (const key of ['condition', 'country_of_origin', 'sar_value', 'regulatory_certification']) assert.equal(result.suggestion.attributeValues[key], undefined);
});

test('UTF-8 grounding offsets, a default-zero segment and formatted keys retain citations', () => {
  const configured = [...attributes, { key: 'manufacturer', label: 'Manufacturer', type: 'text' }];
  const raw = grounded(['manufacturer: Téléphones Example', '**model**: Galaxy A15 5G', '**processor:** Dimensity 6100+', 'storage: 128 GB']);
  delete raw.groundingMetadata.groundingSupports[0].segment.startIndex;
  const result = normalizeGroundedSpecs(raw, { model: 'Galaxy A15 5G', ram: '', storage: '128' }, configured);
  assert.equal(result.suggestion.attributeValues.manufacturer, 'Téléphones Example');
  assert.equal(result.suggestion.attributeValues.processor, 'Dimensity 6100+');
});

test('capacity dropdowns preserve configured GB labels', () => {
  const configured = [{ key: 'model', type: 'text' }, { key: 'storage', label: 'Storage', type: 'dropdown', unit: 'GB', options: ['128 GB', '256 GB'] }];
  const result = normalizeGroundedSpecs(grounded(['model: iPhone 15', 'storage: 128 GB']), { model: 'iPhone 15', ram: '', storage: '128' }, configured);
  assert.equal(result.suggestion.attributeValues.storage, '128 GB');
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
    assert.match(body.contents[0].parts[0].text, /"options":\["4","6","8"\]/);
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

test('phone name alone unlocks smartphone attributes and category after grounded verification', async (t) => {
  const { EventEmitter } = require('node:events');
  const Category = require('../models/Category');
  const Configuration = require('../models/MasterConfiguration');
  const controller = require('../controllers/productSmartFillController');
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'synthetic-name-only-key';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  const phoneId = '0123456789abcdef01234567';
  t.mock.method(Category, 'find', () => ({ select() { return this; }, limit() { return this; }, lean: async () => [{ _id: phoneId, name: 'Iphone', definitionKey: 'smartphones' }] }));
  t.mock.method(Configuration, 'findById', () => ({ lean: async () => ({ structure: { features: {}, attributes: [...attributes.filter(item => ['model', 'dimensions'].includes(item.key)), { key: 'brand', label: 'Brand', type: 'text' }], categoryDefinitions: [{ key: 'smartphones', name: 'Smartphones', attributes: attributes.filter(item => ['ram', 'storage', 'processor', 'battery'].includes(item.key)) }] } }) }));
  const web = grounded(['model: Apple iPhone 15', 'brand: Apple', 'storage: 128 GB', 'ram_options: 6 GB', 'processor: A16 Bionic']);
  const provider = t.mock.method(global, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.tools) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: web.text }] }, groundingMetadata: web.groundingMetadata }] }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ name: 'Apple iPhone 17 256', category: '', description: '', shortDescription: '', multipleProducts: false, priceAmbiguous: false, fieldSources: {}, attributeValues: {} }) }] } }] }) };
  });
  const response = new EventEmitter(); response.json = value => { response.body = value; response.writableEnded = true; };
  let error;
  await controller.fill({ user: { _id: 'name-only-admin' }, tenantFilter: { storeId: 'test-store' }, body: { notes: '', imageUrls: [], existing: { name: 'Iphn 15 128 GB', brand: 'Baldev Communication', attributeValues: { brand: 'Baldev Communication' } } } }, response, value => { error = value; });
  assert.equal(error, undefined);
  assert.equal(response.body.mode, 'web');
  assert.equal(response.body.suggestion.category, phoneId);
  assert.equal(response.body.suggestion.name, 'Apple iPhone 15 128 GB');
  assert.equal(response.body.suggestion.attributeValues.brand, 'Apple');
  assert.equal(response.body.suggestion.attributeValues.storage, '128');
  assert.equal(response.body.suggestion.attributeValues.ram, '6');
  assert.equal(response.body.suggestion.attributeValues.processor, 'A16 Bionic');
  assert.equal(response.body.specificationLookup.status, 'completed');
  assert.ok(response.body.specificationLookup.fieldCount >= 3);
  assert.match(response.body.suggestion.description, /Processor: A16 Bionic/);
  assert.equal(provider.mock.callCount(), 1);
});

test('Gemini quota errors remain visible and do not trigger duplicate provider requests', async (t) => {
  const { EventEmitter } = require('node:events');
  const Category = require('../models/Category');
  const Configuration = require('../models/MasterConfiguration');
  const controller = require('../controllers/productSmartFillController');
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'synthetic-quota-key';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  t.mock.method(Category, 'find', () => ({ select() { return this; }, limit() { return this; }, lean: async () => [] }));
  t.mock.method(Configuration, 'findById', () => ({ lean: async () => ({ structure: { features: {}, attributes, categoryDefinitions: [] } }) }));
  const provider = t.mock.method(global, 'fetch', async () => ({ ok: false, status: 429, json: async () => ({}) }));
  for (const notes of ['', 'Model: iPhone 15']) {
    const response = new EventEmitter(); response.json = value => { response.body = value; response.writableEnded = true; };
    let error;
    await controller.fill({ user: { _id: 'quota-admin' }, body: { notes, imageUrls: [], existing: { name: 'Apple iPhone 15 128 GB' } } }, response, value => { error = value; });
    assert.equal(error, undefined);
    assert.match(response.body.warnings.join(' '), /quota.*exhausted/i);
    assert.equal(response.body.specificationLookup.status, 'failed');
    assert.equal(response.body.specificationLookup.code, 'AI_QUOTA_EXCEEDED');
    assert.equal(response.body.specificationLookup.fieldCount, 0);
  }
  assert.equal(provider.mock.callCount(), 2);
});
