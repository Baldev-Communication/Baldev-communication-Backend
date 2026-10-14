function configuredAttributeValue(definition, raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  if (definition.type === 'boolean') {
    if (/^(true|yes)$/i.test(value)) return 'Yes';
    if (/^(false|no)$/i.test(value)) return 'No';
    return '';
  }
  if (['dropdown', 'multi_select'].includes(definition.type) && definition.options?.length) {
    const selected = definition.type === 'multi_select' ? value.split(',').map(item => item.trim()).filter(Boolean) : [value];
    const matched = selected.map(item => definition.options.find(option => option.toLowerCase() === item.toLowerCase()));
    return matched.length && matched.every(Boolean) ? matched.join(', ') : '';
  }
  return value;
}

module.exports = { configuredAttributeValue };
