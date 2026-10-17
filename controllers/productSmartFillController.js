const rateLimit = require('express-rate-limit');
const Category = require('../models/Category');
const { andFilter } = require('../services/storeService');
const { readConfiguration } = require('../services/masterConfigurationService');
const { analyzeProductContext, captionSuggestion } = require('../services/productImportContext.service');
const { enabled, providers, defaultProvider, providerLabel, supportedProvider } = require('../services/productAiProvider.service');
const { modelIdentity, researchProductSpecs } = require('../services/productWebSpecs.service');
const { configuredAttributeValue } = require('../services/configuredAttributeValue');
const { configuredAttributes } = require('../services/productAttributes');
const { readProductPhoto } = require('../services/productSmartFillMedia');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');

const active = new Set();
const clean = (value, max = 3000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const factFields = { name: 'Name', category: 'Category', subCategory: 'Product type', fabric: 'Fabric', colors: 'Colours', sizes: 'Sizes', occasion: 'Occasion', description: 'Description' };
function sourceText(body, categories, attributes) {
  const existing = body.existing && typeof body.existing === 'object' && !Array.isArray(body.existing) ? body.existing : {};
  const lines = Object.entries(factFields).map(([key, label]) => {
    const raw = key === 'category' ? categories.find(item => String(item._id) === existing.category)?.name : existing[key];
    const value = clean(Array.isArray(raw) ? raw.filter(item => typeof item === 'string').join(', ') : raw, key === 'description' ? 2000 : 200);
    return value ? label + ': ' + value.replace(/\r?\n/g, ' ') : '';
  }).filter(Boolean);
  for (const attribute of attributes) {
    const value = clean(existing.attributeValues?.[attribute.key], 500);
    if (value) lines.push(attribute.label + ': ' + value);
  }
  // Supplier notes go first. Previously entered prices and stock are never
  // reinterpreted as new commercial evidence.
  return [clean(body.notes, 7000), ...lines].filter(Boolean).join('\n').slice(0, 10000);
}

exports.limiter = rateLimit({ windowMs: 60000, max: 12, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => String(req.user._id),
  message: { message: 'Smart Fill has received several requests. Please wait a minute before trying again.' },
});
exports.status = (_req, res) => {
  const available = providers();
  res.json({ enabled: available.some(item => item.enabled), webSupported: available.some(item => item.webSupported), providers: available, defaultProvider: defaultProvider(), notesSupported: true, maxPhotos: 4 });
};
exports.fill = asyncHandler(async (req, res) => {
  const provider = req.body?.provider !== undefined ? req.body.provider : defaultProvider();
  if (!supportedProvider(provider)) throw new ApiError('VALIDATION_ERROR', 'Choose Gemini or ChatGPT for Smart Fill.');
  if (req.body?.provider !== undefined && !enabled(provider)) throw new ApiError('SMART_FILL_UNAVAILABLE', `${providerLabel(provider)} is not configured on the backend. Ask the store administrator to configure its API key, or choose an available AI.`);
  if (req.body?.notes !== undefined && (typeof req.body.notes !== 'string' || req.body.notes.length > 7000)) throw new ApiError('VALIDATION_ERROR', 'Keep supplier notes under 7,000 characters.');
  if (req.body?.webSearch !== undefined && typeof req.body.webSearch !== 'boolean') throw new ApiError('VALIDATION_ERROR', 'Web search preference must be true or false.');
  const urls = req.body?.imageUrls ?? [];
  if (!Array.isArray(urls) || urls.length > 4 || urls.some(url => typeof url !== 'string' || url.length > 4096)) throw new ApiError('VALIDATION_ERROR', 'Select up to four uploaded product photos.');
  const key = String(req.user._id);
  if (active.has(key)) throw new ApiError('DUPLICATE_REQUEST', 'A Smart Fill request is already running. Wait for it to finish.');
  active.add(key);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(110000)]);
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', cancel);
  try {
    const [categories, configuration] = await Promise.all([
      Category.find(andFilter({ isActive: { $ne: false }, isArchived: { $ne: true } }, req.tenantFilter)).select('_id name definitionKey customAttributes').limit(100).lean(), readConfiguration(req.store?._id),
    ]);
    const attributes = configuredAttributes(configuration.structure, categories, req.body?.existing);
    const caption = sourceText(req.body || {}, categories, attributes);
    if (!caption && !urls.length) throw new ApiError('VALIDATION_ERROR', 'Add a product photo, supplier notes or a few product details first.');
    if (!enabled(provider) && !caption) throw new ApiError('SMART_FILL_UNAVAILABLE', 'Photo analysis needs Gemini or ChatGPT configured on the backend. You can still paste supplier notes to fill stated details.');
    const images = []; const warnings = [];
    if (enabled(provider)) {
      for (const url of [...new Set(urls)]) {
        try { images.push(await readProductPhoto(url, signal)); }
        catch (error) { if (signal.aborted) throw error; warnings.push('A selected photo could not be read. Re-upload it for photo analysis.'); }
      }
      if (urls.length && !images.length && !caption) throw new ApiError('SMART_FILL_MEDIA', warnings[0]);
    }
    const nameOnly = !urls.length && !clean(req.body?.notes) && req.body?.webSearch !== false
      && modelIdentity({ existing: req.body?.existing, caption, attributes });
    // The grounded lookup can read an exact model name directly. Avoid a second
    // ungrounded AI request when there are no photos or supplier notes.
    const suggestion = nameOnly ? captionSuggestion(caption, '', categories)
      : await analyzeProductContext({ caption, images, categories, attributes, signal, provider });
    // Configured specifications also work in notes-only mode, but only for a
    // labelled, verbatim value. There are no inferred warranty/material claims.
    suggestion.attributeValues = { ...suggestion.attributeValues };
    for (const attribute of attributes) {
      const labels = [attribute.label, attribute.key].map(value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const match = caption.match(new RegExp(`(?:^|\\n)\\s*(?:${labels})\\s*[:=]\\s*([^\\n]+)`, 'i'));
      if (match && !suggestion.attributeValues[attribute.key]) {
        suggestion.attributeValues[attribute.key] = clean(match[1], 500);
        suggestion.fieldSources['attribute.' + attribute.key] = { source: 'caption', quote: match[0].trim() };
      }
    }
    if (attributes.some(attribute => attribute.key === 'brand') && suggestion.brand && suggestion.fieldSources?.brand
      && !suggestion.attributeValues.brand) {
      suggestion.attributeValues.brand = suggestion.brand;
      suggestion.fieldSources['attribute.brand'] = suggestion.fieldSources.brand;
    }
    if (attributes.some(attribute => attribute.key === 'country_of_origin') && suggestion.countryOfOrigin
      && suggestion.fieldSources?.countryOfOrigin && !suggestion.attributeValues.country_of_origin) {
      suggestion.attributeValues.country_of_origin = suggestion.countryOfOrigin;
      suggestion.fieldSources['attribute.country_of_origin'] = suggestion.fieldSources.countryOfOrigin;
    }
    if (suggestion.contextStatus === 'failed') warnings.push(suggestion.contextError);
    if (!enabled(provider)) warnings.push('Photo AI is not configured. These suggestions use only the details stated in your notes and form.');
    if (suggestion.priceAmbiguous || suggestion.multipleProducts) warnings.push('More than one price or product may be present. Confirm the product and enter its price manually.');
    const existing = req.body?.existing || {};
    let researchAttributes = configuredAttributes(configuration.structure, categories, {
      ...existing, category: existing.category || suggestion.category,
      subCategory: existing.subCategory || suggestion.subCategory,
    });
    let webSources = []; let searchSuggestions = '';
    let specificationLookup = { status: req.body?.webSearch === false ? 'disabled' : enabled(provider) ? 'missing_model' : 'unavailable', fieldCount: 0,
      message: req.body?.webSearch === false ? 'Internet specification lookup is off.' : enabled(provider) ? 'Choose the product category and enter the exact brand and model to fetch specifications.' : 'Configure an AI provider to fetch internet specifications.' };
    const providerUnavailable = ['AI_QUOTA_EXCEEDED', 'AI_ACCESS_DENIED', 'AI_KEY_MISSING'].includes(suggestion.contextErrorCode);
    if (req.body?.webSearch !== false && providerUnavailable) specificationLookup = { status: 'failed', fieldCount: 0, code: suggestion.contextErrorCode, message: suggestion.contextError };
    if (enabled(provider) && req.body?.webSearch !== false && !providerUnavailable) {
      let identity = modelIdentity({ existing, suggestion, caption, attributes: researchAttributes });
      const inferredPhoneCategory = identity && identity.kind !== 'electronics' && !existing.category && !suggestion.category
        ? categories.find(item => /iphone/i.test(identity.model) && /iphone/i.test(item.name))
          || categories.find(item => /^(?:smartphones?|mobile phones?|mobiles)$/i.test(item.name))
          || categories.find(item => /^smartphones(?:_|$)/.test(item.definitionKey || '')) : null;
      if (inferredPhoneCategory) {
        researchAttributes = configuredAttributes(configuration.structure, categories, { ...existing, category: String(inferredPhoneCategory._id) });
        identity = modelIdentity({ existing, suggestion, caption, attributes: researchAttributes });
      }
      if (identity) {
        try {
          const web = await researchProductSpecs({ identity, attributes: researchAttributes, signal, provider });
          const fieldCount = Object.keys(web.suggestion.attributeValues || {}).length;
          specificationLookup = { status: fieldCount ? 'completed' : 'no_verified_specs', fieldCount,
            message: web.warning || (fieldCount ? `${fieldCount} specifications verified from internet sources.` : 'No configured specifications were verified for this exact model. Check its name and variant.') };
          webSources = web.sources;
          searchSuggestions = web.searchSuggestions || '';
          if (web.warning) warnings.push(web.warning);
          if (inferredPhoneCategory && webSources.length) {
            suggestion.category = String(inferredPhoneCategory._id);
            suggestion.fieldSources.category = { source: 'web', quote: `Verified phone model: ${identity.model}`, url: webSources[0].url, title: webSources[0].title };
          }
          for (const [field, value] of Object.entries(web.suggestion)) {
            if (field === 'attributeValues') {
              for (const [key, attributeValue] of Object.entries(value)) {
                if (!suggestion.attributeValues[key] || !web.fieldSources['attribute.' + key]?.reviewRequired) {
                  suggestion.attributeValues[key] = attributeValue;
                  suggestion.fieldSources['attribute.' + key] = web.fieldSources['attribute.' + key];
                }
              }
            } else if (!suggestion[field] || field === 'brand' && suggestion[field] === 'Baldev Communication'
              || ['name', 'description', 'shortDescription', 'highlights', 'tags'].includes(field)) {
              suggestion[field] = value;
              suggestion.fieldSources[field] = web.fieldSources[field];
            }
          }
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error.contextCode ? error.message : 'Internet specs could not be checked right now. Photo and note suggestions remain available.';
          specificationLookup = { status: 'failed', fieldCount: 0, code: error.contextCode || 'AI_SPECIFICATION_LOOKUP_FAILED', message };
          warnings.push(message);
        }
      }
    }
    if (configuration.structure.features?.sizing === false) { delete suggestion.sizes; delete suggestion.sizingMode; delete suggestion.sizeChart; }
    for (const attribute of researchAttributes) {
      const raw = suggestion.attributeValues?.[attribute.key];
      if (!raw) continue;
      const valid = configuredAttributeValue(attribute, raw);
      if (valid) suggestion.attributeValues[attribute.key] = valid;
      else {
        delete suggestion.attributeValues[attribute.key];
        delete suggestion.fieldSources['attribute.' + attribute.key];
        warnings.push(`${attribute.label} needs one of the configured choices. Select it in the form.`);
      }
    }
    if (suggestion.attributeValues.warranty) {
      suggestion.warranty = suggestion.attributeValues.warranty;
      suggestion.fieldSources.warranty = suggestion.fieldSources['attribute.warranty'];
    }
    // Only listing data is returned. No credentials, model configuration or
    // provider responses are included, and nothing is saved or published here.
    const fields = ['name', 'brand', 'category', 'subCategory', 'description', 'shortDescription', 'colors', 'tags', 'highlights', 'fabric', 'occasion', 'sizes', 'sizingMode', 'price', 'originalPrice', 'countryOfOrigin', 'packageDimensions', 'shippingWeightKg', 'warranty', 'attributeValues'];
    const data = Object.fromEntries(fields.filter(field => suggestion[field] !== undefined).map(field => [field, suggestion[field]]));
    if (specificationLookup.status === 'completed') {
      specificationLookup.fieldCount = Object.keys(suggestion.attributeValues || {}).filter(key => suggestion.fieldSources['attribute.' + key]?.source === 'web').length;
      if (!specificationLookup.fieldCount) specificationLookup = { status: 'no_verified_specs', fieldCount: 0, message: 'The returned specifications did not match the configured field choices. Check the model and category.' };
    }
    res.json({ provider, suggestion: data, fieldSources: suggestion.fieldSources || {}, webSources, searchSuggestions, specificationLookup, mode: webSources.length ? 'web' : suggestion.contextStatus === 'completed' ? 'ai' : 'notes', warnings: [...new Set(warnings)] });
  } catch (error) {
    if (signal.aborted && !controller.signal.aborted) throw new ApiError('SMART_FILL_TIMEOUT', 'Smart Fill took too long. Try again with fewer photos, or paste the product details.');
    if (!controller.signal.aborted) throw error;
  } finally { active.delete(key); res.off('close', cancel); }
});
exports.sourceText = sourceText;
exports.configuredAttributes = configuredAttributes;
