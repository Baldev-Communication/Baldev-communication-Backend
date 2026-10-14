const { ApiError } = require('../utils/apiError');

const invalid = message => { throw new ApiError('VALIDATION_ERROR', message, { statusCode: 400 }); };
const parseJson = (raw, label) => {
  try { return JSON.parse(raw); }
  catch { return invalid(`${label} is invalid. Reassign the photos and try again.`); }
};
const detailText = (value, label, max) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > max) invalid(`Keep ${label} under ${max} characters.`);
  return value.trim();
};

function draftUploadPlan(fields = {}, fileCount = 0) {
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 30) invalid('Choose 1 to 30 product photos.');
  const mode = fields.groupMode === 'grouped' ? 'grouped' : fields.groupMode === 'single' ? 'single' : 'separate';
  let assignments;
  if (mode === 'grouped') {
    assignments = parseJson(fields.photoGroups, 'Photo grouping');
    if (!Array.isArray(assignments) || assignments.length !== fileCount || assignments.some(id => !Number.isInteger(id) || id < 1 || id > 30)) invalid('Assign every photo to a product group.');
  } else assignments = Array.from({ length: fileCount }, (_, index) => mode === 'single' ? 1 : index + 1);
  const suppliedDetails = fields.groupDetails ? parseJson(fields.groupDetails, 'Product details') : {};
  if (!suppliedDetails || typeof suppliedDetails !== 'object' || Array.isArray(suppliedDetails)) invalid('Product details must be grouped by product.');
  const groups = [];
  for (const [index, id] of assignments.entries()) {
    let group = groups.find(item => item.id === id);
    if (!group) {
      const raw = suppliedDetails[id] || {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(`Product ${id} details are invalid.`);
      const details = {
        category: detailText(raw.category, 'category', 30),
        model: detailText(raw.model, 'model name', 120),
        ram: detailText(raw.ram, 'RAM', 4),
        storage: detailText(raw.storage, 'storage', 5),
      };
      if (details.category && !/^[a-f\d]{24}$/i.test(details.category)) invalid(`Product ${id} has an invalid category.`);
      if (details.ram && !/^\d{1,3}$/.test(details.ram) || details.storage && !/^\d{1,4}$/.test(details.storage)) invalid(`Product ${id} RAM and storage must be numbers in GB.`);
      if (details.model && !details.category) invalid(`Choose a category for Product ${id} to research its model.`);
      if ((details.ram || details.storage) && !details.model) invalid(`Enter the exact model for Product ${id} before RAM or storage.`);
      group = { id, indexes: [], details };
      groups.push(group);
    }
    group.indexes.push(index);
  }
  return { mode, groups };
}

module.exports = { draftUploadPlan };
