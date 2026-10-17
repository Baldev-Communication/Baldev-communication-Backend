const { configuredAttributes } = require('../../services/productAttributes');
const { categoryTrail } = require('../../services/categoryHierarchy');
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const definitions = [
  ['name', 'Product Name', 'text', ['item description', 'item name', 'product title', 'title']],
  ['category', 'Category', 'category', ['group', 'category path']],
  ['subCategory', 'Subcategory', 'category', ['sub category']],
  ['categoryDefinitionKey', 'Product Type', 'text', ['specification template', 'product template', 'product type key']],
  ['brand', 'Brand', 'text', ['manufacturer', 'company']],
  ['sku', 'SKU', 'text', ['item code', 'product code']],
  ['barcode', 'Barcode', 'text', ['ean', 'upc', 'gtin']],
  ['productId', 'Product ID', 'text', []],
  ['sellingPrice', 'Selling Price', 'money', ['sale price', 'sp', 'retail rate', 'price']],
  ['originalPrice', 'MRP', 'money', ['original price', 'list price']],
  ['costPrice', 'Purchase Price', 'money', ['cost price', 'unit cost']],
  ['stock', 'Stock', 'integer', ['quantity', 'qty', 'stock available', 'available units']],
  ['currency', 'Currency', 'text', []],
  ['description', 'Description', 'text', ['full description']],
  ['shortDescription', 'Short Description', 'text', ['summary']],
  ['warranty', 'Warranty', 'text', ['warranty period']],
  ['gstRate', 'GST Rate', 'number', ['tax rate', 'gst']],
  ['hsnCode', 'HSN Code', 'text', ['hsn']],
  ['supplierName', 'Supplier Name', 'text', ['supplier']],
  ['supplierSku', 'Supplier SKU', 'text', []],
  ['colors', 'Colors', 'list', ['colours']], ['tags', 'Tags', 'list', []],
  ['highlights', 'Highlights', 'list', []],
  ['shippingWeightKg', 'Packed Weight (kg)', 'number', []],
  ['packageDimensions.lengthCm', 'Package Length (cm)', 'number', []],
  ['packageDimensions.widthCm', 'Package Width (cm)', 'number', []],
  ['packageDimensions.heightCm', 'Package Height (cm)', 'number', []],
  ['countryOfOrigin', 'Country of Origin', 'text', []],
  ['manufacturerDetails', 'Manufacturer Details', 'text', []],
  ['status', 'Status', 'text', []],
  ['attributeValues', 'Product Attributes', 'json', ['attributes', 'specifications']],
  ['variants', 'Variants', 'json', []],
  ['rowKind', 'Row Type', 'text', ['record type']],
  ['parentSku', 'Parent SKU', 'text', []],
  ['variantOptions', 'Variant Options', 'json', ['option values']],
].map(([key, label, type, aliases]) => ({ key, label, type, aliases }));

function schema(structure, categories) {
  const categorySchemas = categories.map(category => ({
    ...category,
    path: categoryTrail(category, categories).map(item => item.name).join(' / '),
    attributes: configuredAttributes(structure, categories, { category: category._id, name: '' }),
  }));
  const attributes = new Map();
  for (const definition of structure.categoryDefinitions || []) if (definition.active !== false) {
    for (const attribute of configuredAttributes(structure, categories, { categoryDefinitionKey: definition.key })) attributes.set(attribute.key, attribute);
  }
  for (const category of categorySchemas) for (const attribute of category.attributes) attributes.set(attribute.key, attribute);
  const fields = [...definitions.map(field => field.key === 'categoryDefinitionKey' ? { ...field, options: (structure.categoryDefinitions || []).filter(item => item.active !== false).map(item => item.name) } : field), ...[...attributes.values()].map(attribute => ({
    key: `attributeValues.${attribute.key}`, label: `Spec: ${attribute.label} [${attribute.key}]`,
    type: attribute.type, aliases: [attribute.key, attribute.label], options: attribute.options,
  }))];
  return { fields, categories: categorySchemas, structure };
}

function autoMap(headers, fields, synonyms = {}) {
  return headers.map(header => {
    const declaredKey = header.match(/\[([a-zA-Z][a-zA-Z0-9_.]*)\]\s*\*?$/)?.[1];
    if (declaredKey && fields.some(field => field.key === declaredKey)) return { header, field: declaredKey, candidates: [declaredKey], ambiguous: false };
    const key = normalize(header.replace(/\s*\*$/, ''));
    const exact = fields.filter(field => [field.key, field.label].some(value => normalize(value) === key));
    const matches = exact.length ? exact : fields.filter(field => [...field.aliases || [], ...Array.isArray(synonyms[field.key]) ? synonyms[field.key] : []].some(value => normalize(value) === key));
    if (key === 'producttype') return { header, field: '', candidates: [...new Set(['category', ...matches.map(field => field.key)])], ambiguous: true };
    // Common commercial fields have an explicit meaning. Ambiguous aliases,
    // including a supplier's "Product Type", always require manual mapping.
    return { header, field: matches.length === 1 ? matches[0].key : '', candidates: matches.map(field => field.key), ambiguous: matches.length !== 1 };
  });
}
const editable = key => definitions.some(field => field.key === key) || /^attributeValues\.[a-z][a-z0-9_]{0,60}$/.test(key);
module.exports = { definitions, normalize, schema, autoMap, editable };
