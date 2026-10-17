const { defaultProductType, inferProductType } = require('./productType');
const { categoryTrail } = require('./categoryHierarchy');

function configuredCategory(structure = {}, categories = [], existing = {}) {
  existing = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const definitions = structure.categoryDefinitions || [];
  const trail = categoryTrail(existing.category, categories);
  const leaf = trail[trail.length - 1];
  const category = leaf && { ...leaf, definitionKey: [...trail].reverse().map(item => item.definitionKey || inferProductType(structure, item.name)?.key).find(Boolean) || '' };
  const normalize = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const subcategory = String(existing.subCategory || '').trim().toLowerCase();
  const child = subcategory && definitions.find(item => item.key === normalize(subcategory) || String(item.name || '').toLowerCase() === subcategory);
  const base = defaultProductType(structure, category, existing);
  let cursor = child;
  for (let depth = 0; cursor && depth < 12; depth++) {
    if (!base || cursor.key === base.key) return child;
    cursor = definitions.find(item => item.key === cursor.parentKey);
  }
  return base;
}

function configuredAttributes(structure = {}, categories = [], existing = {}) {
  existing = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const definitions = structure.categoryDefinitions || [];
  const category = categories.find(item => String(item._id) === String(existing.category?._id || existing.category || ''));
  const selected = configuredCategory(structure, categories, existing);
  const merged = new Map((structure.attributes || []).map(item => [item.key, item]));
  const chain = [];
  let cursor = selected;
  while (cursor && chain.length < 12) {
    chain.unshift(cursor);
    const parentKey = cursor.parentKey;
    cursor = definitions.find(item => item.key === parentKey);
  }
  for (const layer of chain) for (const item of layer.attributes || []) {
    if (item && typeof item === 'object' && item.key) merged.set(item.key, { ...merged.get(item.key), ...item });
  }
  for (const item of categoryTrail(category, categories).flatMap(item => item.customAttributes || [])) {
    if (item && /^custom_[a-z][a-z0-9_]{0,32}$/.test(item.key)) merged.set(item.key, item);
  }
  return [...merged.values()].filter(item => item.active !== false);
}

module.exports = { configuredAttributes, configuredCategory };
