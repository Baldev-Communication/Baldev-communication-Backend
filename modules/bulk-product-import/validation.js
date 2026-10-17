const mongoose = require('mongoose');
const Product = require('../../models/Product');
const ProductDraft = require('../../models/ProductDraft');
const { configuredAttributes } = require('../../services/productAttributes');
const { validateAttributeValue } = require('../../services/masterConfigurationService');
const { validateVariantPayload } = require('../../services/variantService');
const { normalize, definitions, editable } = require('./fields');
const { ApiError } = require('../../utils/apiError');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const issue = (field, message, severity = 'error', suggestion = 'Correct this value in the preview.') => ({ field, message, severity, suggestion });
const blank = value => value === '' || value === undefined || value === null;
const regex = value => new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
function safe(value, depth = 0) {
  if (depth > 8) throw new Error('JSON is nested too deeply.');
  if (value && typeof value === 'object') for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || key.startsWith('$') || key.includes('.')) throw new Error('Unsupported JSON field.');
    safe(value[key], depth + 1);
  }
  return value;
}
function set(object, key, value) {
  if (!editable(key)) throw new Error('Choose a configured field.');
  const parts = key.split('.');
  if (parts.length === 1) object[key] = value;
  else { object[parts[0]] ||= {}; object[parts[0]][parts[1]] = value; }
}
function number(value, money = false) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  let text = String(value).trim();
  if (money) text = text.replace(/^(?:INR|₹)\s*/i, '');
  // Accept familiar Indian/international grouping, but never drop arbitrary
  // characters, currency codes, percent signs or supplier annotations.
  if (text.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text) && !/^\d{1,2}(?:,\d{2})*,\d{3}(?:\.\d+)?$/.test(text)) return NaN;
  text = text.replace(/,/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
}
function convert(raw, key) {
  const definition = definitions.find(field => field.key === key);
  if (definition?.type === 'json') return safe(typeof raw === 'string' ? JSON.parse(raw) : raw);
  if (['money', 'number', 'integer'].includes(definition?.type) || key.startsWith('packageDimensions.')) {
    const value = number(raw, definition?.type === 'money');
    if (!Number.isFinite(value) || value < 0 || definition?.type === 'integer' && !Number.isSafeInteger(value)) throw new Error(`${definition?.label || key} must be a valid ${definition?.type === 'integer' ? 'whole number' : 'number'} of zero or more.`);
    return value;
  }
  if (definition?.type === 'list') return Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,|]/).map(value => value.trim()).filter(Boolean);
  return String(raw).trim();
}

function mapRow(row, mapping) {
  const payload = {}, provided = [], issues = [], invalidValues = {};
  (mapping || []).forEach((key, index) => {
    const raw = row.raw[index];
    if (!key || key === '_ignore' || blank(raw)) return;
    if (raw && typeof raw === 'object' && raw.error) { issues.push(issue(key, raw.error)); invalidValues[key] = raw.error; return; }
    try {
      if (!editable(key)) throw new Error('Choose a supported column mapping.');
      const value = convert(raw, key);
      if (provided.includes(key)) throw new Error('Two columns map to this field. Choose one authoritative column.');
      if (key === 'attributeValues') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Product Attributes must be a JSON object.');
        for (const [attribute, supplied] of Object.entries(value)) if (!blank(payload.attributeValues?.[attribute]) && String(payload.attributeValues[attribute]) !== String(supplied)) throw new Error(`Product Attributes JSON conflicts with the ${attribute} column.`);
        payload.attributeValues = { ...payload.attributeValues, ...value };
      } else {
        if (key.startsWith('attributeValues.') && !blank(get(payload, key)) && String(get(payload, key)) !== String(value)) throw new Error('This specification conflicts with Product Attributes JSON.');
        set(payload, key, value);
      }
      provided.push(key);
    } catch (error) { issues.push(issue(key, error.message)); invalidValues[key] = raw; }
  });
  if (payload.attributeValues && (typeof payload.attributeValues !== 'object' || Array.isArray(payload.attributeValues))) issues.push(issue('attributeValues', 'Product Attributes must be a JSON object.'));
  if (payload.attributeValues && typeof payload.attributeValues === 'object' && !Array.isArray(payload.attributeValues)) {
    for (const [key, value] of Object.entries(payload.attributeValues)) {
      if (!/^[a-z][a-z0-9_]{0,60}$/.test(key) || value && typeof value === 'object') issues.push(issue(`attributeValues.${key}`, 'Use configured attribute keys with scalar values.'));
      else payload.attributeValues[key] = String(value ?? '');
    }
  }
  return { payload, provided, issues, invalidValues };
}

function categoryMatch(value, subcategory, context, categoryMappings = {}) {
  const text = String(value || '').trim();
  if (!text) return { category: null, candidates: [] };
  const mapped = categoryMappings[normalize(text)] || text;
  const exact = context.categories.filter(category => String(category._id) === mapped || normalize(category.path) === normalize(mapped) || normalize(category.name) === normalize(mapped) || normalize(category.slug) === normalize(mapped));
  let matches = exact;
  if (!matches.length) {
    matches = context.categories.filter(category => {
      const definition = context.structure.categoryDefinitions.find(item => item.key === category.definitionKey);
      return (definition?.aliases || []).some(alias => normalize(alias) === normalize(text));
    });
  }
  if (subcategory && matches.length === 1) {
    const parentPath = matches[0].path + ' / ';
    matches = context.categories.filter(category => category.path.startsWith(parentPath) && (normalize(category.name) === normalize(subcategory) || normalize(category.path) === normalize(subcategory)));
  }
  return { category: matches.length === 1 ? matches[0] : null, candidates: (matches.length ? matches : context.categories.filter(category => normalize(category.path).includes(normalize(text)) || normalize(text).includes(normalize(category.name)))).slice(0, 8) };
}

function patchForUpdate(payload, existing, allowed, clearFields = []) {
  const patch = {};
  for (const [key, value] of Object.entries(payload)) {
    const permission = key === 'sellingPrice' ? 'price' : key === 'categoryDefinitionKey' ? 'category' : key;
    if (!allowed.includes(permission) || blank(value) || ['productId', 'currency', 'status', 'rowKind', 'parentSku', 'variantOptions', 'subCategory'].includes(key)) continue;
    if (key === 'attributeValues') patch.attributeValues = { ...existing.attributeValues, ...Object.fromEntries(Object.entries(value).filter(([, supplied]) => !blank(supplied))) };
    else if (key === 'sellingPrice') patch.price = value;
    else if (key === 'variants') {
      // Preserve ids, images, availability and unrelated variants. Prices and
      // stock require their own consent even when variant editing is enabled.
      const variants = (existing.variants || []).map(variant => ({ ...variant }));
      for (const input of value) {
        const index = variants.findIndex(variant => input.sku && String(variant.sku || '').trim().toLowerCase() === String(input.sku).trim().toLowerCase());
        const cleaned = Object.fromEntries(Object.entries(input).filter(([, supplied]) => !blank(supplied))); delete cleaned._id; delete cleaned.images;
        if (cleaned.optionValues) cleaned.optionValues = Object.fromEntries(Object.entries(cleaned.optionValues).filter(([, supplied]) => !blank(supplied)));
        if (!allowed.includes('stock')) delete cleaned.stock;
        if (!allowed.includes('price')) delete cleaned.price;
        if (!allowed.includes('originalPrice')) delete cleaned.originalPrice;
        if (index < 0) variants.push(cleaned); else variants[index] = { ...variants[index], ...cleaned, optionValues: { ...variants[index].optionValues, ...cleaned.optionValues } };
      }
      patch.variants = variants;
    } else patch[key] = value;
  }
  for (const key of clearFields) {
    const root = key.split('.')[0];
    if (!allowed.includes(root) || !['description', 'shortDescription', 'warranty', 'supplierName', 'supplierSku', 'tags', 'colors', 'attributeValues'].includes(root)) throw new ApiError('VALIDATION_ERROR', 'This field cannot be explicitly cleared.');
    if (root === 'attributeValues') { patch.attributeValues ||= { ...existing.attributeValues }; patch.attributeValues[key.split('.')[1]] = ''; }
    else patch[key] = ['tags', 'colors'].includes(root) ? [] : '';
  }
  for (const [common, attribute] of [['brand', 'brand'], ['warranty', 'warranty']]) {
    if (allowed.includes(common) && !blank(payload[common]) && payload.attributeValues?.[attribute] !== undefined) {
      patch.attributeValues = { ...existing.attributeValues, ...patch.attributeValues, [attribute]: payload.attributeValues[attribute] };
    }
    if (clearFields.includes(common) && existing.attributeValues?.[attribute] !== undefined) patch.attributeValues = { ...existing.attributeValues, ...patch.attributeValues, [attribute]: '' };
  }
  return patch;
}

async function validateRow(row, batch, context) {
  const data = { ...row.payload, attributeValues: { ...row.payload?.attributeValues } };
  const issues = (row.issues || []).filter(item => item.severity === 'parse' || item.origin === 'enrichment');
  const append = (field, message, severity, suggestion) => issues.push(issue(field, message, severity, suggestion));
  const pendingSources = (row.provenance || []).filter(item => item.verification !== 'verified' && item.verification !== 'rejected');
  if (pendingSources.length) append('enrichment', 'Review the sourced specifications before approval.', 'review', 'Open specifications and accept or reject each sourced field.');
  if (data.currency && !['INR', '₹'].includes(String(data.currency).toUpperCase())) append('currency', 'Only INR is supported. Enter approved INR prices; currency conversion is not automatic.');
  if (data.status && !['draft', 'published', 'active'].includes(String(data.status).toLowerCase())) append('status', 'Choose draft or published. Published still requires separate explicit approval.');
  const match = categoryMatch(data.category, data.subCategory, context, batch.categoryMappings);
  if (match.category) { data.category = String(match.category._id); delete data.subCategory; }
  else if (data.category) append('category', 'Category is unknown or ambiguous.', 'review', 'Choose an existing category or create one in Categories, then refresh and map it.');
  if (data.categoryDefinitionKey) {
    const types = (context.structure.categoryDefinitions || []).filter(item => item.active !== false && [item.key, item.name, ...item.aliases || []].some(value => normalize(value) === normalize(data.categoryDefinitionKey)));
    if (types.length === 1) data.categoryDefinitionKey = types[0].key;
    else append('categoryDefinitionKey', 'Choose one configured product specification type.', 'review');
  }

  const identifiers = [];
  if (data.productId) {
    if (!mongoose.isValidObjectId(data.productId)) append('productId', 'Product ID is invalid.');
    else identifiers.push({ _id: data.productId });
  }
  if (data.sku) identifiers.push({ sku: regex(data.sku) });
  if (data.barcode) identifiers.push({ barcode: String(data.barcode) });
  const products = identifiers.length ? await Product.find({ $and: [context.scope, { $or: identifiers }] }).lean() : [];
  let existing = products.length === 1 ? products[0] : null;
  if (products.length > 1) append('sku', 'Product ID, SKU and barcode identify different records.', 'error', 'Use identifiers belonging to one product.');
  if (data.productId && (!existing || String(existing._id) !== String(data.productId))) append('productId', 'The explicit product ID was not found in this store or conflicts with the other identifiers.');
  if (existing?.isArchived) append('sku', 'This identifier belongs to an archived product. Restore it in Products first.');
  const draftIdentifiers = [...(data.sku ? [{ sku: regex(data.sku) }] : []), ...(data.barcode ? [{ barcode: String(data.barcode) }] : [])];
  const draft = draftIdentifiers.length ? await ProductDraft.findOne({ $and: [context.scope, { $or: draftIdentifiers, status: 'draft', ...(row.draftId ? { _id: { $ne: row.draftId } } : {}) }] }).select('_id name') : null;
  if (draft) append('sku', `SKU or barcode is already used by draft ${draft.name || draft._id}.`, 'duplicate');
  if (existing && batch.mode === 'create') append('sku', `Existing product: ${existing.name}.`, 'duplicate', 'Choose Update existing or Create or update after reviewing the preview.');
  if (!existing && batch.mode === 'update') append('sku', 'No existing product matches these identifiers.', 'error', 'Use an exact product ID, SKU or barcode.');
  const operation = existing ? 'update' : 'create';
  let identityCandidates = [];
  if (!existing && !(row.provided || []).some(key => ['sku', 'barcode', 'productId'].includes(key)) && data.attributeValues.model && (data.brand || data.attributeValues.brand)) {
    const matches = await Product.find({ $and: [context.scope, { isArchived: { $ne: true }, 'attributeValues.model': regex(data.attributeValues.model), $or: [{ brand: regex(data.brand || data.attributeValues.brand) }, { 'attributeValues.brand': regex(data.brand || data.attributeValues.brand) }] }] }).select('name sku attributeValues').limit(8).lean();
    const exact = matches.filter(product => ['ram', 'storage', 'colour', 'condition', 'model_number', 'region'].every(key => !data.attributeValues[key] || String(product.attributeValues?.[key] || '').toLowerCase() === String(data.attributeValues[key]).toLowerCase()));
    if (exact.length) {
      append('identity', 'Existing records match this brand, model and supplied configuration.', 'review', 'Choose the existing record and update mode, or enter an explicit unique SKU for a genuinely separate product.');
      identityCandidates = exact.map(product => ({ kind: 'identity', id: product._id, name: product.name, sku: product.sku }));
    }
  }
  const preliminaryAttributes = configuredAttributes(context.structure, context.categories, { ...existing, ...data });
  for (const [common, attribute] of [['brand', 'brand'], ['warranty', 'warranty']]) {
    if (!blank(data[common]) && preliminaryAttributes.some(field => field.key === attribute)) {
      if (blank(data.attributeValues[attribute])) data.attributeValues[attribute] = data[common];
      else if (String(data.attributeValues[attribute]) !== String(data[common])) append(common, `${common} conflicts with its specification column. Choose one consistent value.`, 'review');
    }
  }
  const patch = existing ? patchForUpdate(data, existing, batch.updateFields || [], row.clearFields || []) : data;
  const combined = existing ? { ...existing, ...patch } : { ...data };
  if (existing) {
    combined.sellingPrice = combined.price;
    if (!Object.keys(patch).length) append('mapping', 'No nonblank mapped fields are approved for update.', 'review', 'Choose the fields this import may update.');
  }
  const category = context.categories.find(item => String(item._id) === String(combined.category));
  if (!combined.name || String(combined.name).trim().length < 3) append('name', 'Enter a product name with at least 3 characters.');
  if (!category) append('category', 'A category is required for publishing.', 'missing');
  else if (category.isArchived || category.isActive === false) append('category', 'Choose a visible, non-archived category.');
  const attributes = configuredAttributes(context.structure, context.categories, combined);
  if (combined.brand && attributes.some(item => item.key === 'brand') && !combined.attributeValues?.brand) combined.attributeValues = { ...combined.attributeValues, brand: combined.brand };
  for (const field of attributes) {
    const value = combined.attributeValues?.[field.key];
    if (field.required && blank(value)) append(`attributeValues.${field.key}`, `${field.label} is required for publishing.`, 'missing');
    if (!blank(value)) try {
      const normalized = require('../../services/productWebSpecs.service').attributeValue(String(value), field);
      combined.attributeValues[field.key] = validateAttributeValue(field, normalized || value);
      if (Object.hasOwn(data.attributeValues, field.key)) data.attributeValues[field.key] = combined.attributeValues[field.key];
    } catch (error) { append(`attributeValues.${field.key}`, error.message); }
  }
  const known = new Set(attributes.map(item => item.key));
  for (const key of Object.keys(data.attributeValues || {})) if (!known.has(key)) {
    if (blank(data.attributeValues[key])) delete data.attributeValues[key];
    else append(`attributeValues.${key}`, 'This attribute is not configured for the selected category.', 'review', 'Change category, map the correct field or explicitly clear this value.');
  }
  for (const key of ['sellingPrice', 'originalPrice', 'stock']) if (blank(combined[key])) append(key, `${key} is required for publishing.`, 'missing');
  const commercialError = require('../../controllers/productDraftController').validateDraftPayload(combined);
  if (commercialError) append('commercial', commercialError);
  if (!blank(combined.sellingPrice) && combined.sellingPrice <= 0) append('sellingPrice', 'Selling price must be greater than zero.');
  if (!blank(combined.originalPrice) && combined.sellingPrice > combined.originalPrice) append('originalPrice', 'Selling price cannot exceed MRP.');
  if (!combined.images?.length) append('images', 'Add an image before publishing. Draft import is allowed.', 'missing');
  const variantError = validateVariantPayload(combined.variants);
  if (variantError) append('variants', variantError);
  if ((combined.variants || []).some(variant => (variant.images || []).some(image => typeof image.url !== 'string' || !/^(?:https:\/\/|\/uploads\/)/.test(image.url)))) append('variants', 'Variant images must use uploaded image URLs.');
  if (combined.variants?.length) {
    const enabled = new Set(context.structure.variantConfig?.attributes || []);
    let definition = context.structure.categoryDefinitions.find(item => item.key === (combined.categoryDefinitionKey || category?.definitionKey));
    for (let depth = 0; definition && depth < 12; depth++) { (definition.variantAttributes || []).forEach(key => enabled.add(key)); definition = context.structure.categoryDefinitions.find(item => item.key === definition.parentKey); }
    for (const variant of combined.variants) {
      if (Object.keys(variant.optionValues || {}).some(key => !enabled.has(key))) append('variants', 'A variant uses an option not enabled for this category.');
      for (const [key, value] of Object.entries(variant.optionValues || {})) {
        const field = attributes.find(item => item.key === key);
        if (field) try { validateAttributeValue(field, value); } catch (error) { append('variants', error.message); }
      }
    }
  }
  if ((combined.variants || []).length && combined.variants.every(variant => Number.isSafeInteger(variant.stock))) {
    combined.stock = combined.variants.filter(variant => variant.isActive !== false).reduce((sum, variant) => sum + variant.stock, 0);
    if (!existing) data.stock = combined.stock;
  }
  const state = issues.some(item => item.severity === 'error' || item.severity === 'parse') ? 'invalid'
    : issues.some(item => item.severity === 'duplicate') ? 'duplicate'
      : issues.some(item => item.severity === 'review') ? 'needs_review'
        : issues.some(item => item.severity === 'missing') ? 'incomplete_draft' : 'ready';
  const stored = { ...data, attributeValues: { ...data.attributeValues } };
  return { payload: stored, issues, state, operation, targetId: existing?._id || null, targetUpdatedAt: existing?.updatedAt || null,
    baseline: existing ? Object.fromEntries(Object.keys(patch).map(key => [key, { before: existing[key], after: patch[key] }])) : {},
    candidates: [...identityCandidates, ...(match.category ? [] : match.candidates.map(item => ({ kind: 'category', id: item._id, name: item.path })))], validationRevision: batch.revision };
}
module.exports = { mapRow, validateRow, categoryMatch, patchForUpdate, number, convert, safe, set, get, regex, blank, issue, own };
