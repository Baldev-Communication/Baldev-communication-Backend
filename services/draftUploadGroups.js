const { ApiError } = require('../utils/apiError');
const { configuredAttributes } = require('./productAttributes');
const { configuredAttributeValue } = require('./configuredAttributeValue');

const invalid = message => { throw new ApiError('VALIDATION_ERROR', message, { statusCode: 400 }); };
const parseJson = (raw, label) => {
  try { return JSON.parse(raw); }
  catch { return invalid(`${label} is invalid. Reassign the photos and try again.`); }
};
const detailText = (value, label, max) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > max) invalid(`Keep ${label} under ${max} characters.`);
  return value.trim();
};

const textLimits = { name: 180, brand: 120, sku: 100, subCategory: 100, categoryDefinitionKey: 50, condition: 500, warranty: 500, colour: 120,
  hsnCode: 20, barcode: 100, supplierName: 160, supplierSku: 100, countryOfOrigin: 120, manufacturerDetails: 1000,
  shortDescription: 240, description: 5000, careInstructions: 2000, returnPolicy: 2000 };
const numericFields = { sellingPrice: {}, originalPrice: {}, costPrice: {}, stock: { integer: true }, gstRate: { max: 100 },
  lowStockAlert: { integer: true }, reorderQuantity: { integer: true }, shippingWeightKg: { max: 1000 }, returnWindowDays: { integer: true, max: 365 } };
const attributeFields = { model: 'model', ram: 'ram', storage: 'storage', brand: 'brand', condition: 'condition', warranty: 'warranty', colour: 'colour', countryOfOrigin: 'country_of_origin' };
const present = value => value !== '' && value !== undefined && value !== null;
function detailNumber(value, label, { integer = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) invalid(`${label} must be a valid number.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max || integer && !Number.isSafeInteger(number)) invalid(`${label} must be ${integer ? 'a whole number' : 'a number'} between 0 and ${max}.`);
  return number;
}
function capacity(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(GB|TB)?$/i);
  const amount = match && Number(match[1]) * (match[2]?.toUpperCase() === 'TB' ? 1024 : 1);
  return Number.isInteger(amount) && amount > 0 && amount <= 16384 ? String(amount) : '';
}

function normalizeDetails(raw, id) {
  const details = { category: detailText(raw.category, 'category', 30), model: detailText(raw.model, 'model name', 120),
    ram: detailText(raw.ram, 'RAM', 20), storage: detailText(raw.storage, 'storage', 20) };
  for (const [key, max] of Object.entries(textLimits)) if (present(raw[key])) details[key] = detailText(raw[key], key, max);
  for (const [key, rules] of Object.entries(numericFields)) if (present(raw[key])) details[key] = detailNumber(raw[key], `Product ${id} ${key}`, rules);
  if (present(details.originalPrice) && present(details.sellingPrice) && details.originalPrice < details.sellingPrice) invalid(`Product ${id}: MRP must be at least the selling price.`);
  if (raw.packageDimensions !== undefined) {
    if (!raw.packageDimensions || typeof raw.packageDimensions !== 'object' || Array.isArray(raw.packageDimensions)) invalid(`Product ${id} packed dimensions are invalid.`);
    const keys = ['lengthCm', 'widthCm', 'heightCm'];
    if (keys.some(key => present(raw.packageDimensions[key]))) {
      if (keys.some(key => !present(raw.packageDimensions[key]) || Number(raw.packageDimensions[key]) <= 0)) invalid(`Product ${id}: enter all three packed dimensions greater than zero.`);
      details.packageDimensions = Object.fromEntries(keys.map(key => [key, detailNumber(raw.packageDimensions[key], `Product ${id} packed ${key}`, { max: 1000 })]));
    }
  }
  if (raw.attributeValues !== undefined) {
    if (!raw.attributeValues || typeof raw.attributeValues !== 'object' || Array.isArray(raw.attributeValues) || Object.keys(raw.attributeValues).length > 100) invalid(`Product ${id} specifications are invalid.`);
    details.attributeValues = Object.fromEntries(Object.entries(raw.attributeValues).filter(([, value]) => present(value)).map(([key, value]) => {
      if (!/^[a-z][a-z0-9_]{0,79}$/.test(key) || ['constructor', 'prototype'].includes(key)) invalid(`Product ${id} has an invalid specification key.`);
      return [key, detailText(value, `Product ${id} ${key}`, 500)];
    }));
  }
  for (const [field, key] of Object.entries(attributeFields)) {
    const value = details.attributeValues?.[key];
    if (value && details[field] && value !== details[field]) invalid(`Product ${id} has conflicting ${field} values.`);
    if (value && !details[field]) details[field] = value;
  }
  if (details.category && !/^[a-f\d]{24}$/i.test(details.category)) invalid(`Product ${id} has an invalid category.`);
  details.category = details.category.toLowerCase();
  if (details.ram && !capacity(details.ram) || details.storage && !capacity(details.storage)) invalid(`Product ${id} RAM and storage must be positive capacities in GB or TB.`);
  if (details.model && !details.category) invalid(`Choose a category for Product ${id} to research its model.`);
  if ((details.ram || details.storage) && !details.model) invalid(`Enter the exact model for Product ${id} before RAM or storage.`);
  return details;
}

function draftUploadSeed(details, { structure = {}, categories = [], productNumber = 1 } = {}) {
  if (details.categoryDefinitionKey && !(structure.categoryDefinitions || []).some(item => item.key === details.categoryDefinitionKey && item.active !== false)) invalid(`Product ${productNumber}: choose an available product type.`);
  const definitions = configuredAttributes(structure, categories, details);
  const values = { ...details.attributeValues };
  for (const [field, key] of Object.entries(attributeFields)) if (details[field]) values[key] = details[field];
  const attributeValues = {};
  for (const [key, raw] of Object.entries(values)) {
    const definition = definitions.find(item => item.key === key);
    // Legacy model seeds also name the draft in stores without a model field.
    if (!definition && ['model', 'ram', 'storage'].includes(key)) continue;
    if (!definition && Object.values(attributeFields).includes(key) && !details.attributeValues?.[key]) continue;
    if (!definition) invalid(`Product ${productNumber}: ${key} is not configured for the selected category.`);
    let value = raw;
    if (['ram', 'storage'].includes(key)) {
      const option = (definition.options || []).find(item => capacity(item) === capacity(raw));
      value = option || capacity(raw);
    }
    value = configuredAttributeValue(definition, value);
    if (!value) invalid(`Product ${productNumber}: choose a valid ${definition.label}.`);
    if (['number', 'measurement', 'range'].includes(definition.type)) {
      const number = Number(value);
      if (!Number.isFinite(number) || definition.validation?.min !== undefined && number < definition.validation.min || definition.validation?.max !== undefined && number > definition.validation.max) invalid(`Product ${productNumber}: enter a valid ${definition.label}.`);
    }
    if (definition.validation?.maxLength && value.length > definition.validation.maxLength || definition.validation?.minLength && value.length < definition.validation.minLength) invalid(`Product ${productNumber}: check the length of ${definition.label}.`);
    if (definition.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`Product ${productNumber}: enter a valid ${definition.label} date.`);
    attributeValues[key] = value;
  }
  const payload = Object.fromEntries([...Object.keys(textLimits), ...Object.keys(numericFields), 'packageDimensions'].filter(key => present(details[key])).map(key => [key, details[key]]));
  delete payload.condition; delete payload.colour;
  payload.name = details.name || details.model || '';
  payload.attributeValues = attributeValues;
  if (present(details.sellingPrice)) payload.price = details.sellingPrice;
  if (details.colour) payload.colors = details.colour.split(',').map(value => value.trim()).filter(Boolean);
  for (const [field, key] of [['brand', 'brand'], ['warranty', 'warranty'], ['countryOfOrigin', 'country_of_origin']]) if (attributeValues[key]) payload[field] = attributeValues[key];
  return payload;
}

function draftUploadPlan(fields = {}, fileCount = 0) {
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 30) invalid('Choose 1 to 30 product photos.');
  const mode = fields.groupMode === 'grouped' ? 'grouped' : fields.groupMode === 'single' ? 'single' : 'separate';
  let assignments;
  if (mode === 'grouped') {
    assignments = parseJson(fields.photoGroups, 'Photo grouping');
    if (!Array.isArray(assignments) || assignments.length !== fileCount || assignments.some(id => !Number.isInteger(id) || id < 1 || id > 30)) invalid('Assign every photo to a product group.');
  } else assignments = Array.from({ length: fileCount }, (_, index) => mode === 'single' ? 1 : index + 1);
  const suppliedDetails = fields.groupDetails ? parseJson(fields.groupDetails, 'Product details') : {};
  if (!suppliedDetails || typeof suppliedDetails !== 'object' || Array.isArray(suppliedDetails)) invalid('Product details must be grouped by product.');
  const groups = [];
  for (const [index, id] of assignments.entries()) {
    let group = groups.find(item => item.id === id);
    if (!group) {
      const raw = suppliedDetails[id] || {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(`Product ${id} details are invalid.`);
      const details = normalizeDetails(raw, id);
      group = { id, indexes: [], details };
      groups.push(group);
    }
    group.indexes.push(index);
  }
  const skus = new Set();
  for (const [index, group] of groups.entries()) {
    const sku = group.details.sku?.toLowerCase();
    if (sku && skus.has(sku)) invalid(`Product ${index + 1}: use a different SKU for each product.`);
    if (sku) skus.add(sku);
  }
  return { mode, groups };
}

module.exports = { draftUploadPlan, draftUploadSeed };
