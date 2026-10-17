const Product = require('../../models/Product');
const crypto = require('node:crypto');
const catalog = require('./catalogProvider');
const { configuredAttributes } = require('../../services/productAttributes');
const { modelIdentity, researchProductSpecs } = require('../../services/productWebSpecs.service');
const { regex, blank } = require('./validation');
const forbidden = new Set(['condition', 'warranty', 'warranty_type', 'warranty_terms', 'gtin', 'mpn', 'country_of_origin', 'device_lock', 'box_contents', 'price', 'sellingPrice', 'originalPrice', 'costPrice', 'gstRate', 'stock', 'shippingWeightKg']);
const comparable = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const commercial = definition => forbidden.has(definition.key) || /\b(?:price|mrp|purchase|cost|stock|inventory|tax|gst|warranty|condition|availability|sku|barcode|gtin|hsn|shipping|parcel|packed|carton)\b/i.test(`${definition.key.replace(/_/g, ' ')} ${definition.label || ''}`);
function sameVariant(requested, source) {
  const keys = new Set(['ram', 'storage', 'region', 'region_code', 'regional_variant', 'model_number', ...Object.keys(requested).filter(key => /(?:region|market|model_number|(?:^|_)ram$|(?:^|_)storage$)/i.test(key))]);
  return [...keys].every(key => !requested[key] || comparable(requested[key]) === comparable(source[key]));
}
async function enrich(row, batch, context) {
  const payload = { ...row.payload, attributeValues: { ...row.payload.attributeValues } };
  const attributes = configuredAttributes(context.structure, context.categories, payload);
  const identity = modelIdentity({ existing: payload, attributes });
  const model = payload.attributeValues?.model || identity?.model;
  const brand = payload.brand || payload.attributeValues?.brand;
  const requested = { ...payload.attributeValues, ...(identity?.ram ? { ram: identity.ram } : {}), ...(identity?.storage ? { storage: identity.storage } : {}) };
  const candidates = model ? await Product.find({ $and: [context.scope, { isArchived: { $ne: true }, 'attributeValues.model': regex(model), ...(brand ? { $or: [{ brand: regex(brand) }, { 'attributeValues.brand': regex(brand) }] } : {}) }] }).select('name sku brand attributeValues').limit(20).lean() : [];
  const matching = candidates.filter(item => sameVariant(requested, item.attributeValues || {}));
  const selected = row.selectedSourceId ? matching.find(item => String(item._id) === String(row.selectedSourceId)) : matching.length === 1 ? matching[0] : null;
  let values = {}, sources = {}, warning = ''; const collected = [];
  if (selected) {
    values = selected.attributeValues || {};
    sources = Object.fromEntries(Object.keys(values).map(key => [`attribute.${key}`, { source: 'existing-record', recordId: String(selected._id), quote: `${selected.name} (${selected.sku || selected._id})` }]));
    collected.push({ values, sources });
  } else if (matching.length > 1) warning = 'Several records match. Select the exact model and configuration before enriching.';
  const sourceCandidates = matching.map(item => ({ kind: 'source', id: item._id, name: item.name, sku: item.sku, model: item.attributeValues?.model, ram: item.attributeValues?.ram, storage: item.attributeValues?.storage }));
  if (!warning && batch.allowCatalog && model) {
    const provided = await catalog.lookup({ brand, model, ram: requested.ram, storage: requested.storage, region: requested.region || requested.region_code });
    const exact = provided.filter(item => comparable(item.model) === comparable(model) && (!brand || comparable(item.brand) === comparable(brand)) && sameVariant(requested, item.attributes || {})).map(item => ({ ...item, id: crypto.createHash('sha256').update(JSON.stringify([item.brand, item.model, item.region, item.attributes])).digest('hex').slice(0, 24) }));
    sourceCandidates.push(...exact.map(item => ({ kind: 'source', id: item.id, name: `${item.brand} ${item.model}`, ram: item.attributes?.ram, storage: item.attributes?.storage })));
    const choice = row.selectedSourceId ? exact.find(item => item.id === String(row.selectedSourceId)) : exact.length === 1 ? exact[0] : null;
    if (choice) {
      const cited = {};
      for (const [key, source] of Object.entries(choice.fieldSources || {})) {
        try { const url = new URL(source.url); if (url.protocol === 'https:' && !url.username && !url.password) cited[`attribute.${key}`] = { source: 'configured-catalog', url: url.href, quote: String(source.quote || '').slice(0, 500) }; } catch { /* Uncited values remain unfilled. */ }
      }
      collected.push({ values: choice.attributes || {}, sources: cited });
    } else if (exact.length > 1) warning = 'Several catalog configurations match. Choose the exact variant before enrichment.';
  }
  if (!warning && row.selectedSourceId && !sourceCandidates.some(item => String(item.id) === String(row.selectedSourceId))) warning = 'Selected source does not match this exact model, region and configuration.';
  if (!warning && batch.allowWeb && identity && !identity.needsModel) {
    const requestedRegion = payload.attributeValues.region || payload.attributeValues.region_code;
    const result = await researchProductSpecs({ identity: { ...identity, ...(requestedRegion ? { region: requestedRegion } : {}) }, attributes, provider: batch.provider });
    values = result.suggestion?.attributeValues || {};
    sources = result.fieldSources || {};
    warning = result.warning || '';
    if (!sameVariant(requested, values)) { values = {}; warning = 'Source did not verify the requested model number, region, RAM or storage. No web specifications were applied.'; }
    collected.push({ values, sources });
    if (!warning) for (const conflict of result.conflicts || []) {
      const key = conflict.field.replace(/^attribute\./, '');
      for (const candidate of conflict.candidates || []) collected.push({ values: { [key]: candidate.value }, sources: { [`attribute.${key}`]: candidate }, conflicting: true });
    }
  } else if (!warning && !collected.length) warning = 'No exact catalog match. Enable configured research or enter a more specific model and configuration.';
  const provenance = [...row.provenance || []];
  for (const { values, sources, conflicting } of collected) for (const definition of attributes) {
    const value = values[definition.key], source = sources[`attribute.${definition.key}`];
    if (commercial(definition) || blank(value) || !source) continue;
    if (['ram', 'storage', 'colour', 'color', 'region', 'region_code'].includes(definition.key) && blank(requested[definition.key])) continue;
    const field = `attributeValues.${definition.key}`;
    const current = payload.attributeValues[definition.key];
    if (provenance.some(item => item.field === field && String(item.value) === String(value))) continue;
    const conflict = Boolean(conflicting) || !blank(current) && String(current) !== String(value);
    if (!conflict && !blank(current)) continue;
    provenance.push({ field, value: String(value), previousValue: current ?? '', conflict,
      sourceType: source.source === 'existing-record' ? 'existing-record' : source.source === 'configured-catalog' ? 'configured-catalog' : 'cited-web-extraction',
      sourceUrl: source.url || '', recordId: source.recordId || '', quote: source.quote || '',
      extractedAt: new Date(), confidence: 'source-present', verification: 'needs_review',
    });
    // Sources are reviewable suggestions. Only literal, nonconflicting missing
    // technical fields are staged. Nothing is labelled verified by an AI score.
    if (!conflict) payload.attributeValues[definition.key] = String(value);
  }
  return { payload, provenance, candidates: sourceCandidates, warning };
}
module.exports = { enrich, sameVariant, forbidden, commercial };
