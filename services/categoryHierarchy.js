const Category = require('../models/Category');
const { andFilter } = require('./storeService');
const categoryId = value => String(value?._id || value?.id || value || '');

function categoryTrail(value, categories = []) {
  const byId = categories instanceof Map ? categories : new Map(categories.map(item => [categoryId(item), item]));
  const trail = [], seen = new Set();
  let current = byId.get(categoryId(value));
  while (current && !seen.has(categoryId(current))) {
    seen.add(categoryId(current)); trail.unshift(current);
    current = byId.get(categoryId(current.parent));
  }
  return trail;
}

function categoryDescendantIds(values, categories = []) {
  const selected = new Set(values.map(categoryId).filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of categories) if (!selected.has(categoryId(item)) && selected.has(categoryId(item.parent))) {
      selected.add(categoryId(item)); changed = true;
    }
  }
  return [...selected];
}

async function includeCategoryAncestors(categories, tenantFilter = {}) {
  const rows = [...categories], known = new Set(rows.map(categoryId));
  for (let depth = 0; depth < 6; depth++) {
    const missing = [...new Set(rows.map(item => categoryId(item.parent)).filter(id => id && !known.has(id)))];
    if (!missing.length) break;
    missing.forEach(id => known.add(id));
    const parents = await Category.find(andFilter({ _id: { $in: missing } }, tenantFilter)).select('_id name parent definitionKey customAttributes').lean();
    rows.push(...parents);
  }
  return rows;
}

module.exports = { categoryId, categoryTrail, categoryDescendantIds, includeCategoryAncestors };
