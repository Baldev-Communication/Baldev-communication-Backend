function configuredAttributes(structure = {}, categories = [], existing = {}) {
  existing = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const definitions = structure.categoryDefinitions || [];
  const category = categories.find(item => String(item._id) === String(existing.category || ''));
  const normalize = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const subcategory = String(existing.subCategory || '').trim().toLowerCase();
  const child = subcategory && definitions.find(item => item.key === normalize(subcategory) || String(item.name || '').toLowerCase() === subcategory);
  const selected = child || [existing.categoryDefinitionKey, category?.definitionKey, normalize(category?.name)]
    .map(key => definitions.find(item => item.key === key)).find(Boolean);
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
  return [...merged.values()].filter(item => item.active !== false);
}

module.exports = { configuredAttributes };
