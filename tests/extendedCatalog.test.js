const test = require('node:test');
const assert = require('node:assert/strict');
const { expandCatalog } = require('../config/extendedCatalog');
const { getIndustryPreset, DEFAULT_STRUCTURE } = require('../config/industryPresets');
const { validateStructure } = require('../services/masterConfigurationService');
const { configuredAttributes } = require('../services/productAttributes');
const { cleanCategorySpecifications } = require('../services/categorySpecifications');
const { draftUploadSeed } = require('../services/draftUploadGroups');

test('mixed catalog templates validate and expose relevant appliance fields without phone requirements', () => {
  for (const structure of [DEFAULT_STRUCTURE, getIndustryPreset('mobile'), getIndustryPreset('electronics')]) {
    assert.doesNotThrow(() => validateStructure(structure));
    for (const key of ['televisions', 'speakers', 'headphones', 'screen_protectors', 'irons', 'washing_machines', 'pressure_cookers', 'mixer_grinders', 'general_products']) {
      const category = { _id: 'category', definitionKey: key };
      const attributes = configuredAttributes(structure, [category], { category: category._id });
      assert.equal(attributes.some(item => item.key === 'model'), true, key);
      assert.equal(attributes.some(item => item.key === 'processor' && item.required), false, key);
    }
  }
  const cooker = configuredAttributes(DEFAULT_STRUCTURE, [{ _id: 'c', definitionKey: 'pressure_cookers' }], { category: 'c' });
  assert.equal(cooker.some(item => item.key === 'ram'), false);
  assert.equal(cooker.find(item => item.key === 'capacity_litres').unit, 'l');
  assert.equal(cooker.find(item => item.key === 'weight').unit, 'kg');
});

test('catalog expansion is additive, idempotent and preserves saved fields, phones and other industries', () => {
  const saved = { industry: 'mobile', attributes: [{ key: 'weight', unit: 'g' }], categoryDefinitions: [
    { key: 'smartphones', name: 'Our phones', attributes: [{ key: 'processor', required: true }] },
    { key: 'televisions', name: 'Our TVs', active: false, attributes: [{ key: 'screen_size', label: 'Custom screen', unit: 'cm' }] },
  ] };
  const before = JSON.stringify(saved);
  const result = expandCatalog(saved);
  assert.equal(JSON.stringify(saved), before);
  assert.deepEqual(expandCatalog(result), result);
  assert.deepEqual(result.categoryDefinitions[0], saved.categoryDefinitions[0]);
  assert.deepEqual(result.categoryDefinitions[1].attributes[0], saved.categoryDefinitions[1].attributes[0]);
  assert.equal(result.categoryDefinitions[1].active, false);
  assert.equal(result.categoryDefinitions[1].attributes.some(item => item.key === 'weight'), false);
  const fashion = { industry: 'fashion', categoryDefinitions: [] };
  assert.equal(expandCatalog(fashion), fashion);
});

test('custom specification fields are isolated by category, validated and retained in draft upload seeds', () => {
  const custom = cleanCategorySpecifications([{ key: 'custom_bowl_diameter', label: 'Bowl diameter', type: 'measurement', unit: 'cm', required: true }]);
  const categories = [{ _id: 'c', definitionKey: 'pressure_cookers', customAttributes: custom }, { _id: 'other', definitionKey: 'televisions' }];
  assert.equal(configuredAttributes(DEFAULT_STRUCTURE, categories, { category: 'c' }).find(item => item.key === custom[0].key).required, true);
  assert.equal(configuredAttributes(DEFAULT_STRUCTURE, categories, { category: 'other' }).some(item => item.key === custom[0].key), false);
  const seed = draftUploadSeed({ category: 'c', name: 'Steel cooker', attributeValues: { capacity_litres: '5', custom_bowl_diameter: '24' } }, { structure: DEFAULT_STRUCTURE, categories });
  assert.equal(seed.attributeValues.custom_bowl_diameter, '24');
  assert.equal(seed.attributeValues.capacity_litres, '5');
  assert.throws(() => cleanCategorySpecifications([{ key: 'condition', label: 'Override', type: 'text' }]), /unique identifiers/);
  assert.throws(() => cleanCategorySpecifications([{ key: 'custom_choice', label: 'Choice', type: 'dropdown', options: [] }]), /Add choices/);
  assert.throws(() => cleanCategorySpecifications(Array(31).fill({})), /at most 30/);
});

test('mixed store names choose relevant templates and unknown types retain custom specifications', () => {
  const { configuredCategory } = require('../services/productAttributes');
  const category = { _id: 'all', name: 'Other electronics', customAttributes: [{ key: 'custom_finish', label: 'Finish', type: 'text' }] };
  for (const [name, key, field] of [
    ['Morphy hair dryer', 'hair_dryers', 'power_consumption'],
    ['Havells hair dryer 2000W', 'hair_dryers', 'heat_settings'],
    ['Bettery bank 22.5W', 'power_banks', 'output_power'],
    ['Bajaj solar torch', 'torches_lights', 'solar_charging'],
    ['Example trimmer', 'personal_care', 'blade_material'],
    ['Example unusual appliance', 'general_products', 'features'],
  ]) {
    const product = { category: 'all', name };
    assert.equal(configuredCategory(DEFAULT_STRUCTURE, [category], product).key, key, name);
    const fields = configuredAttributes(DEFAULT_STRUCTURE, [category], product);
    assert.ok(fields.some(item => item.key === field), name);
    assert.ok(fields.some(item => item.key === 'custom_finish'), name);
    assert.equal(fields.some(item => item.key === 'ram'), false, name);
    assert.equal(fields.find(item => item.key === 'model').required, false, name);
  }
  assert.equal(configuredCategory(DEFAULT_STRUCTURE, [category], { category: 'all', name: 'Hair dryer', categoryDefinitionKey: 'general_products' }).key, 'general_products');
  assert.equal(configuredCategory(DEFAULT_STRUCTURE, [{ _id: 'd', name: 'Hair dryer' }], { category: 'd' }).key, 'hair_dryers');
});
