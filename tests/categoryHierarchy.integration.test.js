const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createProduct } = require('./factories');
const Category = require('../models/Category');
const Store = require('../models/Store');
const Product = require('../models/Product');
const { configuredAttributes } = require('../services/productAttributes');
const { getIndustryPreset } = require('../config/industryPresets');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

async function tree(token) {
  const add = async body => {
    const result = await request('/api/admin/categories', { method: 'POST', token, body });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  };
  const root = await add({ name: 'Watches', slug: 'watches', definitionKey: 'watches', customAttributes: [{ key: 'custom_finish', label: 'Case finish', type: 'text' }] });
  const digital = await add({ name: 'Digital Watches', slug: 'watches-digital', parent: root._id });
  const sports = await add({ name: 'Sports', slug: 'watches-digital-sports', parent: digital._id });
  const smart = await add({ name: 'Smart Watches', slug: 'watches-smart', parent: root._id, definitionKey: 'smart_watches' });
  return { root, digital, sports, smart };
}

const sale = { price: 1500, originalPrice: 2000, stock: 2, description: 'Watch specifications supplied by the store.', images: [{ url: '/uploads/watch.webp', primary: true }] };

test('real subcategories save inherited watch specifications and parent filters/search/brand facets include descendants', async () => {
  const { token } = await createAdmin();
  const { root, digital, sports, smart } = await tree(token);
  const casio = await request('/api/admin/products', { method: 'POST', token, body: { ...sale, sku: 'CASIO-F91W', name: 'Casio F-91W', category: sports._id, brand: 'Casio', attributeValues: { brand: 'Casio', model: 'F-91W', condition: 'New', watch_type: 'Digital', movement: 'Quartz', weight: '21', custom_finish: 'Matte' } } });
  assert.equal(casio.status, 201, JSON.stringify(casio.data));
  assert.equal(casio.data.categoryDefinitionKey, 'watches');
  assert.ok(casio.data.specifications.some(item => item.key === 'weight' && item.unit === 'g'));
  assert.equal(casio.data.attributeValues.custom_finish, 'Matte');
  assert.equal(casio.data.specifications.some(item => item.key === 'compatible_os'), false);
  const noise = await request('/api/admin/products', { method: 'POST', token, body: { ...sale, sku: 'NOISE-COLORFIT', name: 'Noise ColorFit', category: smart._id, brand: 'Noise', attributeValues: { brand: 'Noise', model: 'ColorFit', condition: 'New', warranty: '1 year', compatible_os: 'Android' } } });
  assert.equal(noise.status, 201, JSON.stringify(noise.data));
  const parent = await request(`/api/products?category=${root._id}&includeFacets=true&page=1&limit=20`);
  assert.equal(parent.status, 200, JSON.stringify(parent.data));
  assert.equal(parent.data.items.length, 2);
  assert.equal(parent.data.facets.categories.find(item => item.value === root._id).count, 2);
  assert.equal(parent.data.facets.categories.find(item => item.value === digital._id).label, 'Watches / Digital Watches');
  const brands = parent.data.facets.dynamicFacets.find(item => item.key === 'brand');
  assert.deepEqual(brands.options.map(item => item.value).sort(), ['Casio', 'Noise']);
  const brand = await request(`/api/products?category=${root._id}&attr_brand=Casio&includeFacets=true&page=1&limit=20`);
  assert.deepEqual(brand.data.items.map(item => item.name), ['Casio F-91W']);
  const child = await request(`/api/products?category=${digital._id}&includeFacets=true&page=1&limit=20`);
  assert.equal(child.data.items.length, 1);
  const search = await request('/api/products?search=Watches&includeFacets=true&page=1&limit=20');
  assert.equal(search.data.items.length, 2);
  const unknown = await request(`/api/products?category=${new mongoose.Types.ObjectId()}&includeFacets=true&page=1&limit=20`);
  assert.equal(unknown.data.items.length, 0);
  const admin = await request('/api/admin/categories?admin=true', { token });
  assert.equal(admin.data.find(item => item._id === root._id).productCount, 2);
});

test('draft publication retains the selected child ID and specifications from its parent template', async () => {
  const { token } = await createAdmin();
  const { sports } = await tree(token);
  const draft = await request('/api/admin/product-drafts', { method: 'POST', token, body: { ...sale, sellingPrice: 1500, name: 'Sonata digital watch', category: sports._id, attributeValues: { brand: 'Sonata', model: '77118', condition: 'New', watch_type: 'Digital', movement: 'Quartz', custom_finish: 'Gloss' } } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const result = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token, body: { ids: [draft.data.data._id] } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.data.products.length, 1, JSON.stringify(result.data));
  const saved = await Product.findById(result.data.data.products[0]._id).lean();
  assert.equal(String(saved.category), sports._id);
  assert.equal(saved.categoryDefinitionKey, 'watches');
  assert.equal(saved.attributeValues.custom_finish, 'Gloss');
});

test('hierarchy rejects cycles and foreign-store parents while legacy root products and brand fields remain filterable', async () => {
  const { token } = await createAdmin();
  const { root, sports } = await tree(token);
  const cycle = await request(`/api/admin/categories/${root._id}`, { method: 'PUT', token, body: { parent: sports._id } });
  assert.equal(cycle.status, 400);
  const other = await Store.create({ name: 'Other', slug: 'other-watch-store', status: 'PUBLISHED' });
  const foreign = await Category.create({ name: 'Foreign', slug: 'foreign', storeId: other._id });
  const rejected = await request('/api/admin/categories', { method: 'POST', token, body: { name: 'Foreign child', slug: 'foreign-child', parent: String(foreign._id) } });
  assert.equal(rejected.status, 400);
  await createProduct({ name: 'Old Casio listing', category: root._id, brand: 'Casio', subCategory: 'Legacy digital', attributeValues: { brand: '' } });
  await createProduct({ name: 'Other tenant listing', category: foreign._id, brand: 'Casio', storeId: other._id });
  const result = await request(`/api/products?category=${root._id}&attr_brand=Casio&includeFacets=true&page=1&limit=20`);
  assert.deepEqual(result.data.items.map(item => item.name), ['Old Casio listing']);
  assert.equal(result.data.facets.dynamicFacets.find(item => item.key === 'brand').options[0].value, 'Casio');
});

test('digital watch fields do not require smartphone or smart-watch specifications', () => {
  const structure = getIndustryPreset('mobile');
  const attributes = configuredAttributes(structure, [{ _id: 'watch', name: 'Watches', definitionKey: 'watches' }, { _id: 'digital', name: 'Digital', parent: 'watch' }], { category: 'digital' });
  assert.equal(attributes.some(item => item.key === 'movement'), true);
  assert.equal(attributes.some(item => ['processor', 'compatible_os', 'ram'].includes(item.key)), false);
  assert.equal(attributes.find(item => item.key === 'weight').unit, 'g');
  const smart = configuredAttributes(structure, [{ _id: 'watch', name: 'Watches', definitionKey: 'watches' }], { category: 'watch', name: 'Apple Watch Series 9' });
  assert.equal(smart.some(item => item.key === 'compatible_os'), true);
  const automatic = [{ _id: 'watch', name: 'Watches' }, { _id: 'sports', name: 'Sports', parent: 'watch' }];
  assert.equal(configuredAttributes(structure, automatic, { category: 'sports' }).some(item => item.key === 'movement'), true);
});
