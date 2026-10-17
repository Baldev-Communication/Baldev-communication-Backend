const test = require('node:test');
const assert = require('node:assert/strict');
const { draftUploadPlan, draftUploadSeed } = require('../services/draftUploadGroups');
const { getIndustryPreset } = require('../config/industryPresets');
const category = { _id: '0123456789abcdef01234567', name: 'Smartphones', definitionKey: 'smartphones' };
const structure = getIndustryPreset('mobile');
const planFor = details => draftUploadPlan({ groupMode: 'single', groupDetails: JSON.stringify({ 1: details }) }, 1).groups[0].details;

test('nine photos can be assigned to product groups of four, three and two', () => {
  const plan = draftUploadPlan({ groupMode: 'grouped', photoGroups: JSON.stringify([1, 1, 1, 1, 2, 2, 2, 3, 3]), groupDetails: '{}' }, 9);
  assert.deepEqual(plan.groups.map(group => group.indexes), [[0, 1, 2, 3], [4, 5, 6], [7, 8]]);
});

test('grouping rejects missing assignments and ambiguous model details', () => {
  assert.throws(() => draftUploadPlan({ groupMode: 'grouped', photoGroups: '[1,1]' }, 3), /Assign every photo/);
  assert.throws(() => draftUploadPlan({ groupMode: 'single', groupDetails: JSON.stringify({ 1: { model: 'iPhone 17' } }) }, 1), /Choose a category/);
  assert.throws(() => draftUploadPlan({ groupMode: 'single', groupDetails: JSON.stringify({ 1: { ram: '8' } }) }, 1), /exact model/);
});

test('manual prices, stock, condition, warranty and detailed fields become the matching draft seed', () => {
  const parsed = planFor({ category: category._id, name: 'OPPO Reno16c Starry White 256 GB', model: 'OPPO Reno16c 5G', brand: 'OPPO', ram: '8 GB', storage: '256 GB',
    sku: 'OPPO-WHITE-01', condition: 'Used', warranty: '3 month seller warranty', colour: 'Starry White', sellingPrice: '19999', originalPrice: '22999', costPrice: '18000', stock: '3', gstRate: '18',
    supplierName: 'Local supplier', supplierSku: 'SUP-01', hsnCode: '8517', barcode: '1234567890', countryOfOrigin: 'India', manufacturerDetails: 'Manufacturer address',
    shippingWeightKg: '0.5', packageDimensions: { lengthCm: '20', widthCm: '10', heightCm: '5' }, shortDescription: 'Seller checked item', description: 'Actual item description',
    attributeValues: { processor: 'Seller provided chipset', dimensions: '155 x 72 x 8 mm', box_contents: 'Phone and cable', warranty_type: 'Seller' }, status: 'published', storeId: 'not-authorized', image: 'untrusted-image',
  });
  const seed = draftUploadSeed(parsed, { structure, categories: [category] });
  assert.equal(seed.name, 'OPPO Reno16c Starry White 256 GB'); assert.equal(seed.price, 19999); assert.equal(seed.sellingPrice, 19999); assert.equal(seed.originalPrice, 22999);
  assert.equal(seed.stock, 3); assert.equal(seed.costPrice, 18000); assert.equal(seed.gstRate, 18); assert.equal(seed.sku, 'OPPO-WHITE-01');
  assert.equal(seed.attributeValues.condition, 'Used'); assert.equal(seed.attributeValues.warranty_type, 'Seller'); assert.equal(seed.warranty, '3 month seller warranty');
  assert.equal(seed.attributeValues.processor, 'Seller provided chipset'); assert.equal(seed.attributeValues.dimensions, '155 x 72 x 8 mm');
  assert.deepEqual(seed.packageDimensions, { lengthCm: 20, widthCm: 10, heightCm: 5 }); assert.equal(seed.shippingWeightKg, 0.5);
  assert.equal(seed.supplierSku, 'SUP-01'); assert.deepEqual(seed.colors, ['Starry White']); assert.equal(seed.countryOfOrigin, 'India');
  assert.equal(seed.storeId, undefined); assert.equal(seed.status, undefined); assert.equal(seed.image, undefined);
});

test('empty and zero-valued manual fields stay distinct and no price is inferred', () => {
  const seed = draftUploadSeed(planFor({ sellingPrice: '99', stock: '0', gstRate: '0', costPrice: '' }), { structure });
  assert.equal(seed.price, 99); assert.equal(seed.stock, 0); assert.equal(seed.gstRate, 0);
  assert.equal(seed.originalPrice, undefined); assert.equal(seed.costPrice, undefined);
  assert.deepEqual(draftUploadSeed(planFor({}), { structure }), { name: '', attributeValues: {} });
});

test('invalid commercial values, partial parcels and duplicate SKUs are rejected before upload storage', () => {
  for (const details of [{ sellingPrice: '-1' }, { stock: '1.5' }, { stock: true }, { gstRate: '101' }, { sellingPrice: '100', originalPrice: '99' },
    { shippingWeightKg: '1001' }, { costPrice: 'Infinity' }, { packageDimensions: { lengthCm: '20' } }, { name: 'x'.repeat(181) }, { attributeValues: { constructor: 'bad' } }]) {
    assert.throws(() => planFor(details), error => error.errorCode === 'VALIDATION_ERROR');
  }
  assert.throws(() => draftUploadPlan({ groupMode: 'separate', groupDetails: JSON.stringify({ 1: { sku: 'SKU-1' }, 2: { sku: 'sku-1' } }) }, 2), /different SKU/);
});

test('only the selected category specifications and valid condition choices are accepted', () => {
  assert.throws(() => draftUploadSeed(planFor({ category: category._id, condition: 'Good' }), { structure, categories: [category] }), /valid Condition/);
  assert.throws(() => draftUploadSeed(planFor({ category: category._id, attributeValues: { unknown_field: 'value' } }), { structure, categories: [category] }), /not configured/);
  const constrained = { attributes: [{ key: 'weight', label: 'Weight', type: 'measurement', validation: { min: 0, max: 500 } }] };
  assert.throws(() => draftUploadSeed(planFor({ attributeValues: { weight: '501' } }), { structure: constrained }), /valid Weight/);
  const normalized = draftUploadSeed(planFor({ condition: 'used', warranty: 'Seller coverage' }), { structure });
  assert.equal(normalized.attributeValues.condition, 'Used'); assert.equal(normalized.warranty, 'Seller coverage');
});
