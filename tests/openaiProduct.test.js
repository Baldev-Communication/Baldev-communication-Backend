const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { generateOpenAIProduct, groundedResponse, DEFAULT_MODEL } = require('../services/openaiProduct.service');
const { analyzeProductContext } = require('../services/productImportContext.service');
const { normalizeGroundedSpecs } = require('../services/productWebSpecs.service');
const controller = require('../controllers/productSmartFillController');
const Category = require('../models/Category');
const Configuration = require('../models/MasterConfiguration');

const source = 'https://manufacturer.example/phone';
const attributes = [
  { key: 'model', label: 'Model', type: 'text' }, { key: 'brand', label: 'Brand', type: 'text' },
  { key: 'processor', label: 'Processor', type: 'text' }, { key: 'dimensions', label: 'Dimensions', type: 'text' },
  { key: 'storage', label: 'Storage', type: 'dropdown', options: ['128', '256'], unit: 'GB' },
  { key: 'condition', label: 'Condition', type: 'dropdown', options: ['New', 'Used'] },
];

test.beforeEach(t => {
  const keys = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'GEMINI_API_KEY'];
  const before = keys.map(key => process.env[key]);
  process.env.OPENAI_API_KEY = 'synthetic-openai-test-key';
  process.env.GEMINI_API_KEY = 'synthetic-gemini-test-key';
  delete process.env.OPENAI_MODEL;
  t.after(() => keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; }));
});

function textPart(lines, cited = lines.map((_, index) => index)) {
  const text = lines.join('\n'); let start = 0;
  const annotations = lines.flatMap((line, index) => {
    const end = start + Array.from(line).length;
    const annotation = { type: 'url_citation', start_index: start, end_index: end, url: source, title: 'Official specifications' };
    start = end + 1;
    return cited.includes(index) ? [annotation] : [];
  });
  return { type: 'output_text', text, annotations };
}
const payload = (part, search = false) => ({ status: 'completed', output: [
  ...(search ? [{ type: 'web_search_call', status: 'completed' }] : []),
  { type: 'message', role: 'assistant', content: [part] },
] });
const ok = value => ({ ok: true, status: 200, json: async () => value });
const res = () => { const value = new EventEmitter(); value.json = body => { value.body = body; value.writableEnded = true; }; return value; };
const invoke = async body => { const response = res(); let error; await controller.fill({ user: { _id: 'openai-test-admin' }, tenantFilter: { storeId: 'store-test' }, body }, response, value => { error = value; }); return { response, error }; };

test('ChatGPT photo analysis uses Responses JSON output and the common evidence validation', async t => {
  const raw = { name: 'Nova Charger', brand: 'Nova', multipleProducts: false, priceAmbiguous: false,
    attributeValues: { processor: 'An imagined processor', condition: 'Good' }, stock: 100,
    fieldSources: { brand: { source: 'on_screen', quote: 'Brand: Nova' }, 'attribute.processor': { source: 'visual', quote: 'Looks fast' }, 'attribute.condition': { source: 'on_screen', quote: 'Good' } },
  };
  process.env.OPENAI_MODEL = 'configured-vision-model';
  const request = t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-openai-test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'configured-vision-model'); assert.equal(body.store, false);
    assert.deepEqual(body.text.format, { type: 'json_object' }); assert.equal(body.tools, undefined);
    const photos = body.input[0].content.filter(item => item.type === 'input_image');
    assert.equal(photos.length, 4); assert.ok(photos.every(item => item.image_url.startsWith('data:image/jpeg;base64,') && item.detail === 'high'));
    assert.ok(!options.body.includes('synthetic-openai-test-key'));
    return ok(payload({ type: 'output_text', text: JSON.stringify(raw) }));
  });
  const result = await analyzeProductContext({ provider: 'openai', caption: 'Name: Nova Charger', attributes,
    images: Array.from({ length: 4 }, () => ({ mimeType: 'image/jpeg', buffer: Buffer.from([255, 216, 255, 1]) })),
  });
  assert.equal(result.contextStatus, 'completed'); assert.equal(result.brand, 'Nova');
  assert.equal(result.attributeValues.processor, undefined); assert.equal(result.attributeValues.condition, undefined);
  assert.equal(result.stock, undefined); assert.equal(request.mock.callCount(), 1);
});

test('OpenAI web evidence preserves Unicode and keeps only API-cited fields for the exact variant', () => {
  const part = textPart(['model: Apple iPhone 15 citeturn0search0', 'brand: Apple', 'storage: 128 GB',
    'dimensions: 147.6 × 71.6 × 7.8 mm', 'processor: A16 Bionic', 'condition: New'], [0, 1, 2, 3, 5]);
  const raw = groundedResponse([part]);
  assert.ok(!raw.text.includes('cite'));
  const result = normalizeGroundedSpecs(raw, { model: 'Apple iPhone 15', ram: '', storage: '128' }, attributes);
  assert.equal(result.suggestion.attributeValues.dimensions, '147.6 × 71.6 × 7.8 mm');
  assert.equal(result.suggestion.attributeValues.storage, '128');
  assert.equal(result.suggestion.attributeValues.processor, undefined);
  assert.equal(result.suggestion.attributeValues.condition, undefined);
  assert.equal(result.fieldSources['attribute.dimensions'].url, source);
  assert.deepEqual(normalizeGroundedSpecs(raw, { model: 'Apple iPhone 15 Pro', storage: '128' }, attributes).suggestion, {});
});

test('citation markers support their own line only; unsafe URLs and invalid ranges cannot supply evidence', () => {
  const marker = 'citeturn0search0';
  const text = `model: iPhone 15 ${marker}\nprocessor: Uncited chip`;
  const start = text.indexOf(marker);
  const raw = groundedResponse([{ type: 'output_text', text, annotations: [
    { type: 'url_citation', start_index: start, end_index: start + marker.length, url: source, title: 'Official specs' },
    { type: 'url_citation', start_index: 0, end_index: text.length, url: 'javascript:alert(1)' },
    { type: 'url_citation', start_index: -1, end_index: text.length, url: source },
  ] }]);
  const result = normalizeGroundedSpecs(raw, { model: 'iPhone 15' }, attributes);
  assert.equal(result.suggestion.name, 'iPhone 15'); assert.equal(result.suggestion.attributeValues.processor, undefined);
  assert.equal(raw.groundingMetadata.groundingChunks.length, 1);
});

test('web lookup requires a completed search and preserves default model configuration', async t => {
  let searched = true;
  t.mock.method(global, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, DEFAULT_MODEL); assert.equal(body.tool_choice, 'required');
    assert.deepEqual(body.tools, [{ type: 'web_search' }]); assert.equal(body.text, undefined);
    return ok(payload(textPart(['model: iPhone 15']), searched));
  });
  const value = await generateOpenAIProduct({ parts: [{ text: 'Research the model' }], webSearch: true });
  assert.equal(value.raw.groundingMetadata.groundingChunks[0].web.uri, source);
  searched = false;
  await assert.rejects(generateOpenAIProduct({ parts: [{ text: 'Research the model' }], webSearch: true }), error => error.contextCode === 'AI_SEARCH_UNSUPPORTED');
});

test('OpenAI errors, refusals and incomplete outputs never leak payloads or retry another provider', async t => {
  let reply;
  const request = t.mock.method(global, 'fetch', async () => reply);
  for (const [status, code] of [[429, 'AI_QUOTA_EXCEEDED'], [401, 'AI_ACCESS_DENIED'], [403, 'AI_ACCESS_DENIED'], [404, 'AI_MODEL_UNAVAILABLE'], [500, 'AI_PROVIDER_UNAVAILABLE'], [400, 'AI_REQUEST_REJECTED']]) {
    reply = { ok: false, status, json: async () => ({ error: { message: 'secret-provider-payload synthetic-openai-test-key' } }) };
    await assert.rejects(generateOpenAIProduct({ parts: [{ text: 'JSON listing' }] }), error => error.contextCode === code && !/secret-provider|synthetic-openai/.test(error.message));
  }
  for (const [value, code] of [
    [{ status: 'incomplete', output: [] }, 'AI_RESPONSE_INCOMPLETE'],
    [payload({ type: 'refusal', refusal: 'sensitive-provider-refusal' }), 'AI_CONTENT_BLOCKED'],
    [payload({ type: 'output_text', text: '{ broken' }), 'AI_INVALID_RESPONSE'],
    [payload({ type: 'output_text', text: '[]' }), 'AI_INVALID_RESPONSE'],
  ]) {
    reply = ok(value);
    await assert.rejects(generateOpenAIProduct({ parts: [{ text: 'JSON listing' }] }), error => error.contextCode === code && !error.message.includes('sensitive-provider'));
  }
  assert.equal(request.mock.callCount(), 10);
});

test('missing keys, unsupported media, cancellation and timeout have bounded safe failures', async t => {
  const request = t.mock.method(global, 'fetch', async () => { throw new DOMException('sensitive network detail', 'TimeoutError'); });
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(generateOpenAIProduct({ parts: [] }), error => error.contextCode === 'AI_KEY_MISSING');
  process.env.OPENAI_API_KEY = 'synthetic-openai-test-key';
  await assert.rejects(generateOpenAIProduct({ parts: [{ inlineData: { mimeType: 'video/mp4', data: 'x' } }] }), error => error.contextCode === 'AI_MEDIA_UNSUPPORTED');
  assert.equal(request.mock.callCount(), 0);
  await assert.rejects(generateOpenAIProduct({ parts: [] }), error => error.contextCode === 'AI_TIMEOUT');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(generateOpenAIProduct({ parts: [], signal: abort.signal }), error => error.name === 'AbortError');
  assert.equal(request.mock.callCount(), 1);
});

test('status reports per-provider availability without credentials and defaults to the configured provider', () => {
  let value; controller.status({}, { json: body => { value = body; } });
  assert.equal(value.providers.length, 2); assert.equal(value.defaultProvider, 'gemini');
  assert.ok(!JSON.stringify(value).includes('synthetic-'));
  delete process.env.GEMINI_API_KEY;
  controller.status({}, { json: body => { value = body; } });
  assert.equal(value.defaultProvider, 'openai'); assert.equal(value.enabled, true);
  delete process.env.OPENAI_API_KEY;
  controller.status({}, { json: body => { value = body; } });
  assert.equal(value.enabled, false); assert.equal(value.webSupported, false); assert.equal(value.notesSupported, true);
});

function mockCatalog(t) {
  t.mock.method(Category, 'find', filter => {
    assert.ok(JSON.stringify(filter).includes('store-test'));
    return { select() { return this; }, limit() { return this; }, lean: async () => [{ _id: 'phones', name: 'Smartphones', definitionKey: 'smartphones' }] };
  });
  t.mock.method(Configuration, 'findById', () => ({ lean: async () => ({ structure: { features: { sizing: false }, attributes, categoryDefinitions: [] } }) }));
}

test('selecting ChatGPT routes name-based specs through OpenAI and returns review data without product writes', async t => {
  mockCatalog(t);
  const Product = require('../models/Product');
  const write = t.mock.method(Product, 'create', () => { throw new Error('No writes allowed'); });
  const request = t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body); assert.equal(body.tools[0].type, 'web_search');
    assert.ok(options.body.includes('dimensions')); assert.ok(!options.body.includes('private-form-secret'));
    return ok(payload(textPart(['model: Apple iPhone 15', 'brand: Apple', 'storage: 128 GB', 'processor: A16 Bionic']), true));
  });
  const { response, error } = await invoke({ provider: 'openai', existing: { name: 'Apple iPhone 15 128 GB', apiKey: 'private-form-secret' } });
  assert.equal(error, undefined); assert.equal(response.body.provider, 'openai'); assert.equal(response.body.mode, 'web');
  assert.equal(response.body.suggestion.attributeValues.processor, 'A16 Bionic'); assert.equal(response.body.webSources[0].url, source);
  assert.ok(!JSON.stringify(response.body).includes('synthetic-')); assert.equal(response.listenerCount('close'), 0);
  assert.equal(request.mock.callCount(), 1); assert.equal(write.mock.callCount(), 0);
});

test('unavailable and invalid explicit providers fail before database or provider work', async t => {
  delete process.env.OPENAI_API_KEY;
  const query = t.mock.method(Category, 'find', () => { throw new Error('Do not query'); });
  const request = t.mock.method(global, 'fetch', () => { throw new Error('Do not call AI'); });
  for (const provider of ['invalid', {}, null, 'https://attacker.example']) {
    const { error } = await invoke({ provider, notes: 'Name: iPhone 15' });
    assert.equal(error.errorCode, 'VALIDATION_ERROR');
  }
  const { error } = await invoke({ provider: 'openai', notes: 'Name: iPhone 15' });
  assert.equal(error.errorCode, 'SMART_FILL_UNAVAILABLE'); assert.match(error.message, /ChatGPT/);
  assert.equal(query.mock.callCount(), 0); assert.equal(request.mock.callCount(), 0);
});

test('ChatGPT quota failure is visible and never spends a Gemini request or a duplicate web call', async t => {
  mockCatalog(t);
  const request = t.mock.method(global, 'fetch', async url => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    return { ok: false, status: 429, json: async () => ({}) };
  });
  for (const notes of ['', 'Model: iPhone 15']) {
    const { response, error } = await invoke({ provider: 'openai', notes, existing: { name: 'iPhone 15 128 GB' } });
    assert.equal(error, undefined); assert.equal(response.body.provider, 'openai'); assert.equal(response.body.mode, 'notes');
    assert.match(response.body.warnings.join(' '), /ChatGPT.*quota/);
  }
  assert.equal(request.mock.callCount(), 2);
});
