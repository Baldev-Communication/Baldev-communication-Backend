const { ApiError } = require('../utils/apiError');

const types = new Set(['text', 'textarea', 'number', 'measurement', 'dropdown', 'multi_select', 'boolean', 'date', 'color']);
function cleanCategorySpecifications(value = []) {
  const bad = message => { throw new ApiError('VALIDATION_ERROR', message); };
  if (!Array.isArray(value) || value.length > 30) bad('Use at most 30 additional specification fields per category.');
  const keys = new Set();
  return value.map((item, index) => {
    const key = typeof item?.key === 'string' ? item.key.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    const unit = typeof item?.unit === 'string' ? item.unit.trim() : '';
    if (!/^custom_[a-z][a-z0-9_]{0,32}$/.test(key) || keys.has(key)) bad('Additional specification fields need unique identifiers.');
    if (!label || label.length > 80 || unit.length > 20 || !types.has(item.type)) bad('Check the specification name, type and unit.');
    keys.add(key);
    const options = item.options === undefined ? [] : item.options;
    if (!Array.isArray(options) || options.length > 50 || options.some(option => typeof option !== 'string' || !option.trim() || option.trim().length > 100 || option.includes(','))) bad(`${label}: use up to 50 options without commas inside an option.`);
    const uniqueOptions = [...new Set(options.map(option => option.trim()))];
    if (['dropdown', 'multi_select'].includes(item.type) && !uniqueOptions.length) bad(`Add choices for ${label}.`);
    return {
      key, label, type: item.type, unit: item.type === 'measurement' ? unit : '',
      options: ['dropdown', 'multi_select'].includes(item.type) ? uniqueOptions : [],
      required: item.required === true, active: true, searchable: true, filterable: false,
      showOnDetail: true, showInSpecifications: true, variant: false, defaultValue: '',
      sortOrder: 500 + index, group: 'Additional specifications',
      validation: ['number', 'measurement'].includes(item.type) ? {} : { maxLength: 500 },
    };
  });
}

module.exports = { cleanCategorySpecifications };
