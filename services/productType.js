const normalized = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const technologyCatalog = structure => ['mobile', 'electronics'].includes(structure.industry || structure.id);

function inferProductType(structure = {}, text = '') {
  const target = ` ${normalized(text)} `;
  const matches = (structure.categoryDefinitions || []).filter(item => item.active !== false).flatMap(item =>
    [item.name, ...(item.aliases || [])].map(term => ({ item, term: normalized(term) }))
      .filter(({ term }) => term.length >= 3 && (target.includes(` ${term} `) || target.includes(` ${term}s `))));
  matches.sort((a, b) => b.term.length - a.term.length);
  return matches[0]?.item;
}

function defaultProductType(structure = {}, category = {}, product = {}) {
  const definitions = structure.categoryDefinitions || [];
  const explicit = definitions.find(item => item.key === product.categoryDefinitionKey);
  if (explicit) return explicit;
  const named = definitions.find(item => item.key === category.definitionKey || (category.name && normalized(item.name) === normalized(category.name)));
  const inferredCategory = named || inferProductType(structure, category.name);
  if (inferredCategory && !['accessories', 'appliances', 'general_products', 'personal_care', 'watches'].includes(inferredCategory.key)) return inferredCategory;
  if (!technologyCatalog(structure)) return inferredCategory;
  return inferProductType(structure, product.name) || inferredCategory || definitions.find(item => item.key === 'general_products');
}

module.exports = { inferProductType, defaultProductType };
