const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin } = require('./factories');
const Configuration = require('../models/MasterConfiguration');
const Category = require('../models/Category');
const Store = require('../models/Store');
const { getIndustryPreset } = require('../config/industryPresets');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('different product types share a store category and survive draft publication with their own specifications', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Household electronics', slug: 'household-electronics', definitionKey: 'general_products' });
  const base = { category: String(category._id), price: 1500, sellingPrice: 1500, originalPrice: 1500, stock: 2,
    images: [{ url: '/uploads/appliance.webp', primary: true }], description: 'An appliance supplied with the listed features.' };
  const dryer = await request('/api/admin/products', { method: 'POST', token, body: { ...base,
    name: 'Example hair dryer', sku: 'DRYER-MIXED', categoryDefinitionKey: 'hair_dryers',
    attributeValues: { condition: 'New', power_consumption: '2000', heat_settings: '3', cool_shot: 'Yes' },
  } });
  assert.equal(dryer.status, 201, JSON.stringify(dryer.data));
  assert.equal(dryer.data.categoryDefinitionKey, 'hair_dryers');
  assert.equal(dryer.data.attributeValues.model, undefined);
  const draft = await request('/api/admin/product-drafts', { method: 'POST', token, body: { ...base,
    name: 'Example solar torch', sku: 'TORCH-MIXED', categoryDefinitionKey: 'torches_lights',
    attributeValues: { condition: 'New', solar_charging: 'Yes', light_output: '100' },
  } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal(draft.data.data.categoryDefinitionKey, 'torches_lights');
  const published = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token, body: { ids: [draft.data.data._id] } });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const product = published.data.data.products[0];
  assert.equal(product.categoryDefinitionKey, 'torches_lights');
  assert.equal(product.attributeValues.solar_charging, 'Yes');
  const storefront = await request(`/api/products/${product.slug}`);
  assert.equal(storefront.status, 200, JSON.stringify(storefront.data));
  assert.ok(storefront.data.specifications.some(item => item.key === 'light_output' && item.value === '100' && item.unit === 'lm'));
  assert.equal(storefront.data.specifications.some(item => item.key === 'ram' || item.key === 'power_consumption'), false);
});

test('an existing mobile store receives the new templates without rewriting its saved configuration', async () => {
  const structure = JSON.parse(JSON.stringify(getIndustryPreset('mobile')));
  structure.categoryDefinitions = structure.categoryDefinitions.filter(item => item.key === 'smartphones');
  structure.attributes.find(item => item.key === 'warranty').label = 'Our warranty';
  await Configuration.create({ _id: 'store', structure, revision: 7, locked: true });
  const store = await require('../services/storeService').ensureDefaultStore();
  await Store.updateOne({ _id: store._id }, { $set: { catalogStructure: structure, industryRevision: 7 } });
  const response = await request('/api/catalog-configuration');
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.revision, 7);
  assert.equal(response.data.attributes.find(item => item.key === 'warranty').label, 'Our warranty');
  assert.ok(response.data.categoryDefinitions.some(item => item.key === 'washing_machines'));
  const persisted = await Configuration.findById('store').lean();
  assert.equal(persisted.structure.categoryDefinitions.length, 1);
  assert.equal((await Store.findById(store._id).lean()).catalogStructure.categoryDefinitions.length, 1);
});

test('admin creates a TV category with custom fields and customers receive saved detailed specifications', async () => {
  const { token } = await createAdmin();
  const category = await request('/api/admin/categories', { method: 'POST', token, body: {
    name: 'TV', definitionKey: 'televisions', customAttributes: [{ key: 'custom_mount', label: 'Mount size', type: 'measurement', unit: 'mm', required: true }],
  } });
  assert.equal(category.status, 201, JSON.stringify(category.data));
  const base = { name: 'Example 43 inch TV', sku: 'TV-001', category: category.data._id,
    price: 24000, originalPrice: 30000, stock: 2, images: [{ url: '/uploads/television.webp', primary: true }],
    attributeValues: { condition: 'New', brand: 'Example', model: 'TV43', screen_size: '43', resolution: '3840 x 2160', smart_tv: 'Yes' },
  };
  const missing = await request('/api/admin/products', { method: 'POST', token, body: base });
  assert.equal(missing.status, 400);
  assert.match(missing.data.message, /Mount size/);
  const saved = await request('/api/admin/products', { method: 'POST', token, body: { ...base, attributeValues: { ...base.attributeValues, custom_mount: '200' } } });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const storefront = await request(`/api/products/${saved.data.slug}`);
  assert.equal(storefront.status, 200, JSON.stringify(storefront.data));
  assert.ok(storefront.data.specifications.some(item => item.key === 'custom_mount' && item.value === '200' && item.unit === 'mm'));
  assert.ok(storefront.data.specifications.some(item => item.key === 'screen_size' && item.value === '43'));
  assert.equal(storefront.data.specifications.some(item => item.key === 'ram'), false);
  const incompatible = await request(`/api/admin/categories/${category.data._id}`, { method: 'PUT', token, body: { customAttributes: [] } });
  assert.equal(incompatible.status, 400);
  assert.match(incompatible.data.message, /used by products or drafts/);
  const retained = await Category.findById(category.data._id).lean();
  assert.equal(retained.customAttributes.length, 1);
});

test('a cooker draft publishes with litre and material details, and phones retain their required processor', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Cookers', slug: 'cookers', definitionKey: 'pressure_cookers', customAttributes: [
    { key: 'custom_handle_length', label: 'Handle length', type: 'measurement', unit: 'cm', required: true },
  ] });
  const draft = await request('/api/admin/product-drafts', { method: 'POST', token, body: {
    name: 'Steel pressure cooker', sku: 'COOKER-001', category: String(category._id),
    price: 1500, sellingPrice: 1500, originalPrice: 2000, stock: 3,
    images: [{ url: '/uploads/cooker.webp', primary: true }],
    attributeValues: { condition: 'New', capacity_litres: '5', material: 'Stainless steel', induction_compatible: 'Yes', custom_handle_length: '15' },
  } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const removal = await request(`/api/admin/categories/${category._id}`, { method: 'PUT', token, body: { customAttributes: [] } });
  assert.equal(removal.status, 400);
  assert.match(removal.data.message, /used by products or drafts/);
  const published = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token, body: { ids: [draft.data.data._id] } });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.data.products.length, 1, JSON.stringify(published.data));
  const product = published.data.data.products[0];
  assert.equal(product.attributeValues.capacity_litres, '5');
  assert.equal(product.attributeValues.material, 'Stainless steel');
  assert.equal(product.attributeValues.custom_handle_length, '15');
  const phone = await Category.create({ name: 'Phones', slug: 'phones', definitionKey: 'smartphones' });
  const invalidPhone = await request('/api/admin/products', { method: 'POST', token, body: {
    name: 'Example phone', sku: 'PHONE-001', category: String(phone._id), price: 10000, originalPrice: 12000, stock: 1,
    images: [{ url: '/uploads/phone.webp' }], attributeValues: { brand: 'Example', model: 'Phone X', condition: 'New', warranty: '1 year' },
  } });
  assert.equal(invalidPhone.status, 400);
  assert.match(invalidPhone.data.message, /Processor/);
});
