const ExcelJS = require('exceljs');
const { inflateRawSync } = require('node:zlib');
const { definitions } = require('./fields');
const LIMITS = { bytes: 8 * 1024 * 1024, rows: 10000, columns: 250, cells: 750000, sheets: 20 };
const fail = message => { throw new Error(message); };

// Reject oversized ZIPs before ExcelJS inflates anything. XLSM, encryption,
// external relationships and executable content are never needed for imports.
function inspectZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length) fail('Choose a valid XLSX workbook.');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16), total = 0;
  if (!count || count > 2048 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) fail('Workbook archive is unsupported or too large.');
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) fail('Workbook archive is invalid.');
    const flags = buffer.readUInt16LE(cursor + 8), size = buffer.readUInt32LE(cursor + 24);
    const nameSize = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    total += size;
    if (flags & 1 || size > 32 * 1024 * 1024 || total > 64 * 1024 * 1024 || /(?:vbaProject|externalLinks|\.bin$|^\/|\.\.)/i.test(name)) fail('Workbook contains unsupported content or exceeds the expanded size limit.');
    const compression = buffer.readUInt16LE(cursor + 10), compressedSize = buffer.readUInt32LE(cursor + 20), local = buffer.readUInt32LE(cursor + 42);
    if (![0, 8].includes(compression) || local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) fail('Unsupported workbook archive entry.');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressedSize > buffer.length) fail('Workbook archive is truncated.');
    const compressed = buffer.subarray(start, start + compressedSize);
    const expanded = compression === 8 ? inflateRawSync(compressed, { maxOutputLength: 32 * 1024 * 1024 }) : compressed;
    if (expanded.length !== size) fail('Workbook expanded size does not match its archive metadata.');
    cursor += 46 + nameSize + extra + comment;
    if (cursor > end) fail('Workbook archive is invalid.');
  }
}

function csvRows(text) {
  if (text.includes('\0')) fail('CSV must contain UTF-8 text.');
  const counts = { ',': 0, ';': 0, '\t': 0 }; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && inQuotes && text[i + 1] === '"') { i++; continue; }
    if (text[i] === '"') inQuotes = !inQuotes;
    else if (!inQuotes && /[\r\n]/.test(text[i])) break;
    else if (!inQuotes && Object.hasOwn(counts, text[i])) counts[text[i]]++;
  }
  const delimiter = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const rows = []; let row = [], cell = '', quoted = false, justClosed = false;
  function pushCell() { if (cell.length > 16000) fail('A cell exceeds 16,000 characters.'); row.push(cell); cell = ''; justClosed = false; if (row.length > LIMITS.columns) fail('A sheet has too many columns.'); }
  function pushRow() { pushCell(); rows.push(row); row = []; if (rows.length > LIMITS.rows + 1) fail('The file exceeds 10,000 rows.'); }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') { quoted = false; justClosed = true; } else cell += char; }
    else if (char === '"' && !cell && !justClosed) quoted = true;
    else if (char === delimiter) pushCell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i++; pushRow(); }
    else { if (justClosed && char.trim()) fail('Invalid quoted CSV cell.'); cell += char; }
  }
  if (quoted) fail('CSV has an unclosed quoted cell.');
  if (cell || row.length) pushRow();
  return rows;
}

function scalar(cell) {
  const value = cell.value;
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value.formula !== undefined || value.sharedFormula !== undefined) return { error: 'Formula cells are not imported. Replace the formula with its literal value.' };
  if (value.richText) return value.richText.map(item => item.text).join('');
  if (value.hyperlink) return String(value.text || '');
  return { error: 'Unsupported cell value. Enter plain text or a number.' };
}

async function parse(buffer, name) {
  buffer = Buffer.from(buffer);
  if (!buffer.length || buffer.length > LIMITS.bytes) fail('Choose a file up to 8 MB.');
  let sheets;
  if (/\.csv$/i.test(name)) sheets = [{ name: 'Products', rows: csvRows(new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')) }];
  else if (/\.xlsx$/i.test(name)) {
    inspectZip(buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer, { ignoreNodes: ['dataValidations', 'mergeCells', 'conditionalFormatting', 'drawing', 'picture', 'extLst', 'sheetProtection', 'tableParts'] });
    if (workbook.worksheets.length > LIMITS.sheets) fail('Choose a workbook with at most 20 sheets.');
    sheets = workbook.worksheets.filter(sheet => sheet.state === 'visible').map(sheet => {
      if (sheet.rowCount > LIMITS.rows + 1 || sheet.columnCount > LIMITS.columns) fail(`Sheet ${sheet.name} exceeds the row or column limit.`);
      const rows = []; sheet.eachRow({ includeEmpty: true }, row => {
        const values = []; for (let i = 1; i <= sheet.columnCount; i++) values.push(scalar(row.getCell(i)));
        rows.push(values);
      });
      return { name: sheet.name, rows };
    });
  } else fail('Only .xlsx and UTF-8 .csv files are supported.');
  let rowCount = 0, cellCount = 0;
  const result = sheets.map(sheet => {
    if (['__proto__', 'prototype', 'constructor'].includes(sheet.name) || sheet.name.startsWith('$')) fail('Rename the unsupported worksheet before importing.');
    const headers = (sheet.rows.shift() || []).map((value, i) => typeof value === 'object' ? `Column ${i + 1}` : String(value || `Column ${i + 1}`).trim());
    const rows = sheet.rows.map((raw, index) => ({ rowNumber: index + 2, raw: raw.map(value => {
      if (typeof value === 'string' && value.length > 16000) fail('A cell exceeds 16,000 characters.');
      return value;
    }) })).filter(row => row.raw.some(value => value !== '' && value != null));
    const selected = !/^(?:instructions|fields|categories|_options)$/i.test(sheet.name);
    if (selected) rowCount += rows.length;
    cellCount += rows.length * headers.length;
    return { name: sheet.name, headers, rows, selected };
  }).filter(sheet => sheet.headers.length);
  if (!result.length || rowCount > LIMITS.rows || cellCount > LIMITS.cells) fail('Workbook exceeds 10,000 rows or 750,000 cells.');
  return result;
}

function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const toCsv = rows => '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');

async function template(metadata, categoryId) {
  const category = categoryId && metadata.categories.find(item => String(item._id) === categoryId);
  if (categoryId && !category) fail('Choose an existing category.');
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'Baldev Communication';
  const common = definitions.filter(field => !['variants', 'rowKind', 'parentSku', 'variantOptions'].includes(field.key));
  const fields = [...common, ...(category ? category.attributes.map(item => ({ key: `attributeValues.${item.key}`, label: `Spec: ${item.label} [${item.key}]`, type: item.type, required: item.required, options: item.options, unit: item.unit, validation: item.validation })) : metadata.fields.filter(field => ['attributeValues.model', 'attributeValues.condition'].includes(field.key)))];
  const products = workbook.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
  products.columns = fields.map(field => ({ header: `${field.key === 'categoryDefinitionKey' ? 'Product Type [categoryDefinitionKey]' : field.label}${field.required || field.key === 'name' ? ' *' : ''}`, key: field.key, width: ['description', 'attributeValues'].includes(field.key) ? 48 : 24 }));
  const options = workbook.addWorksheet('_Options'); options.state = 'veryHidden';
  const categories = metadata.categories.map(item => item.path);
  categories.forEach((value, index) => options.getCell(index + 1, 1).value = value);
  let optionColumn = 1;
  fields.forEach((field, index) => {
    const header = products.getCell(1, index + 1);
    header.note = `${field.required || field.key === 'name' ? 'Required' : 'Optional for draft'}; type: ${field.type}${field.unit ? `; unit: ${field.unit}` : ''}`;
    products.getColumn(index + 1).numFmt = ['money', 'number', 'integer'].includes(field.type) ? '0.00' : '@';
    const values = field.key === 'category' ? categories : field.key === 'categoryDefinitionKey' ? metadata.structure.categoryDefinitions.filter(item => item.active !== false).map(item => item.name) : field.key === 'status' ? ['draft'] : field.key === 'currency' ? ['INR'] : field.options;
    if (['money', 'integer', 'number', 'measurement', 'range'].includes(field.type)) {
      for (let row = 2; row <= 501; row++) products.getCell(row, index + 1).dataValidation = { type: field.type === 'integer' ? 'whole' : 'decimal', operator: 'between', allowBlank: true, formulae: [field.validation?.min ?? 0, field.key === 'gstRate' ? 100 : field.validation?.max ?? 1000000000], showErrorMessage: true, error: 'Enter a valid nonnegative number in the configured range.' };
    }
    if (values?.length) {
      let column;
      if (field.key === 'category') column = 1;
      else { column = ++optionColumn; values.forEach((value, row) => options.getCell(row + 1, column).value = value); }
      const letter = options.getColumn(column).letter;
      for (let row = 2; row <= 501; row++) products.getCell(row, index + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`'_Options'!$${letter}$1:$${letter}$${values.length}`], showErrorMessage: true, error: 'Choose a configured value.' };
    }
  });
  if (category) products.getCell(2, fields.findIndex(field => field.key === 'category') + 1).value = category.path;
  if (category) {
    const type = require('../../services/productAttributes').configuredCategory(metadata.structure, metadata.categories, { category: category._id });
    if (type) products.getCell(2, fields.findIndex(field => field.key === 'categoryDefinitionKey') + 1).value = type.name;
  }
  products.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: fields.length } };
  const variants = workbook.addWorksheet('Variants', { views: [{ state: 'frozen', ySplit: 1 }] });
  variants.addRow(['Row Type', 'Parent SKU', 'SKU', 'Selling Price', 'MRP', 'Stock', 'Variant Options']);
  const fieldsSheet = workbook.addWorksheet('Fields');
  fieldsSheet.addRow(['Category', 'Field key', 'Label', 'Type', 'Required for publishing', 'Unit', 'Allowed values']);
  for (const item of category ? [category] : metadata.categories) for (const field of item.attributes) fieldsSheet.addRow([item.path, field.key, field.label, field.type, field.required ? 'Yes' : 'No', field.unit || '', (field.options || []).join(' | ')]);
  if (!category) for (const type of metadata.structure.categoryDefinitions.filter(item => item.active !== false)) for (const field of require('../../services/productAttributes').configuredAttributes(metadata.structure, metadata.categories, { categoryDefinitionKey: type.key })) {
    fieldsSheet.addRow([`Product type: ${type.name}`, field.key, field.label, field.type, field.required ? 'Yes' : 'No', field.unit || '', (field.options || []).join(' | ')]);
  }
  const instructions = workbook.addWorksheet('Instructions');
  [
    ['Step', 'Instructions'], ['1', 'Fill Products. One parent product per row. No images are required for draft imports.'],
    ['2', 'Use an exact category path. See Fields for every configured specification, type, unit and option.'],
    ['3', 'Universal attributes: enter a JSON object in Product Attributes, e.g. {"model":"exact model"}. Category templates also expose each configured specification as a column.'],
    ['4', 'Variants: use Row Type = variant, an exact Parent SKU and unique SKU. Variant Options is JSON using the configured variant keys. Select both Products and Variants when importing.'],
    ['5', 'Blank cells preserve existing values. Prices, stock and warranty must be supplied or confirmed by the administrator. Currency is INR; no currency conversion is performed.'],
    ['6', 'Upload, select sheets, review mapping, validate, correct rows, select approved records and save drafts or approve updates. Publishing is a separate action using existing rules.'],
    ['7', 'Formulas, macros and external workbook links are not imported. Paste literal values. CSV must use UTF-8 and comma, semicolon or tab delimiters.'],
    ['8', 'SKU images: SKU_1.jpg, SKU_2.jpg. The image manager previews exact SKU matches before attaching uploads.'],
  ].forEach(row => instructions.addRow(row));
  instructions.columns = [{ width: 10 }, { width: 110 }];
  for (const sheet of workbook.worksheets.filter(item => item.state === 'visible')) {
    sheet.getRow(1).height = 30;
    sheet.getRow(1).eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D1F34' } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
    if (sheet !== products && sheet !== instructions) sheet.columns.forEach(column => column.width = 28);
    sheet.eachRow((row, number) => { if (number > 1) row.eachCell(cell => { cell.alignment = { vertical: 'top', wrapText: true }; }); });
  }
  return workbook.xlsx.writeBuffer();
}
module.exports = { LIMITS, parse, csvRows, toCsv, template, inspectZip };
