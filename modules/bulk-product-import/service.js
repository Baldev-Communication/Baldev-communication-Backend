const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const mongoose = require('mongoose');
const { Batch, Row, Profile, Identity } = require('./models');
const Category = require('../../models/Category');
const Store = require('../../models/Store');
const { readConfiguration } = require('../../services/masterConfigurationService');
const { defaultStoreFilter } = require('../../services/storeService');
const { schema, autoMap, editable } = require('./fields');
const { mapRow, safe, set, issue, convert, blank } = require('./validation');
const { ApiError } = require('../../utils/apiError');
const { logAudit } = require('../../services/auditService');

const bad = message => { throw new ApiError('VALIDATION_ERROR', message); };
const busyStates = ['editing', 'validating', 'queued', 'processing'];
const storeScope = store => store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id };
function captureAuthorization(req) {
  const master = require('../../config/masterOwner').isMasterOwner(req.user);
  return { kind: master ? 'master' : req.store?.isDefault ? 'default-admin' : 'member', ...(master ? { versionHash: crypto.createHash('sha256').update(String(req.user.masterSessionVersion || '')).digest('hex') } : {}) };
}
let indexPromise, activeParsers = 0;
function ensureReady() {
  if (!indexPromise) indexPromise = Promise.all([Batch, Row, Profile, Identity].map(Model => Model.createIndexes())).then(() => require('../../models/ProductDraft').collection.createIndex({ sourceImportRowId: 1 }, { unique: true, sparse: true })).catch(error => { indexPromise = null; throw error; });
  return indexPromise;
}
async function context(storeId) {
  const store = await Store.findById(storeId).lean();
  if (!store) bad('Select a store before importing.');
  const scope = storeScope(store);
  const [configuration, categories] = await Promise.all([readConfiguration(storeId), Category.find(scope).lean()]);
  return { ...schema(configuration.structure, categories), scope, store };
}
function batchScope(req) {
  if (!req.store?._id) bad('Select a store before importing.');
  return { storeId: req.store._id };
}
async function load(req, id) {
  if (!mongoose.isValidObjectId(id)) bad('Import batch ID is invalid.');
  const batch = await Batch.findOne({ _id: id, ...batchScope(req) });
  if (!batch) throw new ApiError('NOT_FOUND', 'Import batch not found.');
  return batch;
}
function parseFile(buffer, name) {
  if (activeParsers >= 1) throw new ApiError('SERVICE_UNAVAILABLE', 'Another spreadsheet is being parsed. Retry this upload in a moment.');
  activeParsers++;
  return new Promise((resolve, reject) => {
    let responded = false;
    const worker = new Worker(require.resolve('./parser.worker'), { workerData: { buffer, name }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { worker.terminate(); reject(new ApiError('VALIDATION_ERROR', 'Spreadsheet parsing exceeded 30 seconds. Split the workbook into smaller files.')); }, 30000);
    const finish = callback => value => { clearTimeout(timer); callback(value); };
    worker.once('message', finish(result => { responded = true; worker.terminate(); result.error ? reject(new ApiError('VALIDATION_ERROR', result.error)) : resolve(result.sheets); }));
    worker.once('error', finish(() => { responded = true; reject(new ApiError('VALIDATION_ERROR', 'Spreadsheet could not be parsed safely. Check its format and size.')); }));
    worker.once('exit', () => { clearTimeout(timer); if (!responded) reject(new ApiError('VALIDATION_ERROR', 'Spreadsheet parser stopped. Try a smaller workbook.')); });
  }).finally(() => { activeParsers--; });
}
async function upload(req) {
  if (!req.file) bad('Choose an XLSX or CSV file.');
  const uploadKey = String(req.body.uploadKey || '');
  if (!/^[a-f0-9-]{16,64}$/i.test(uploadKey)) bad('An upload retry identifier is required.');
  const id = crypto.createHash('sha256').update(`${req.store._id}:${req.user._id}:${uploadKey}`).digest('hex').slice(0, 24);
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const prior = await Batch.findOne({ _id: id, ...batchScope(req) });
  if (prior?.cleanup?.requestedAt) bad('This import was cleared or is being cleared. Start a new upload to import the file again.');
  if (prior && prior.fileHash !== hash) bad('The upload identifier was already used for a different file. Choose a new upload.');
  if (prior && prior.sheets?.length) return prior;
  const sheets = await parseFile(req.file.buffer, req.file.originalname);
  const metadata = await context(req.store._id);
  const mappings = Object.fromEntries(sheets.map(sheet => [sheet.name, autoMap(sheet.headers, metadata.fields).map(column => column.field)]));
  const batch = await Batch.findOneAndUpdate({ _id: id }, { $setOnInsert: {
    ...batchScope(req), createdBy: req.user._id, authorization: captureAuthorization(req), fileHash: hash, fileName: String(req.file.originalname).replace(/[\x00-\x1f]/g, '').slice(0, 180), status: 'mapping',
  } }, { upsert: true, new: true });
  for (const sheet of sheets) {
    for (let start = 0; start < sheet.rows.length; start += 250) {
      await Row.bulkWrite(sheet.rows.slice(start, start + 250).map(row => ({ updateOne: {
        filter: { batchId: id, sheet: sheet.name, rowNumber: row.rowNumber },
        update: { $setOnInsert: { ...batchScope(req), batchId: id, sheet: sheet.name, rowNumber: row.rowNumber, raw: row.raw, state: sheet.selected ? 'pending' : 'excluded', draftId: new mongoose.Types.ObjectId() } }, upsert: true,
      } })));
    }
  }
  batch.sheets = sheets.map(sheet => ({ name: sheet.name, headers: sheet.headers, total: sheet.rows.length, selected: sheet.selected, sample: sheet.rows.slice(0, 3).map(row => row.raw) }));
  batch.mappings = mappings; batch.summary = { total: sheets.filter(sheet => sheet.selected).reduce((sum, sheet) => sum + sheet.rows.length, 0) }; await batch.save();
  await logAudit({ req, action: 'PRODUCT_IMPORT_UPLOADED', entityType: 'BulkProductImport', entityId: batch._id, after: { fileName: batch.fileName, total: sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0) } });
  return batch;
}
async function edit(req, id, body, work, { queue = true, nextStatus, job = 'validate' } = {}) {
  const batch = await load(req, id);
  if (batch.cleanup?.requestedAt && job !== 'cleanup') bad('This import is closed for cleanup. Upload the file again as a new import.');
  if (busyStates.includes(batch.status)) throw new ApiError('DUPLICATE_REQUEST', 'This import is processing. Wait or cancel before editing.');
  if (!Number.isInteger(body.revision) || body.revision !== batch.revision) throw new ApiError('DUPLICATE_REQUEST', 'Import changed in another tab. Refresh before saving.');
  const token = crypto.randomUUID();
  const locked = await Batch.findOneAndUpdate({ _id: batch._id, revision: body.revision, status: batch.status }, { $set: { status: 'editing', leaseToken: token, leaseUntil: new Date(Date.now() + 120000), cancelRequested: false, lastActor: req.user._id, authorization: captureAuthorization(req) }, $inc: { revision: 1 } }, { new: true });
  if (!locked) throw new ApiError('DUPLICATE_REQUEST', 'Import changed. Refresh before saving.');
  const heartbeat = setInterval(() => Batch.updateOne({ _id: locked._id, leaseToken: token }, { $set: { leaseUntil: new Date(Date.now() + 120000) } }).catch(() => {}), 20000); heartbeat.unref();
  try {
    await work(locked);
    await Batch.updateOne({ _id: locked._id, leaseToken: token }, { $set: { status: nextStatus || (queue ? 'validating' : 'preview'), job, jobDone: 0, lastError: '' }, $unset: { leaseToken: 1, leaseUntil: 1, jobTotal: 1 } });
  } catch (error) {
    // Revalidation recovers safely even if an edit spans several row writes.
    await Batch.updateOne({ _id: locked._id, leaseToken: token }, { $set: { status: 'validating', job: 'validate', lastError: 'Review the refreshed preview before retrying this request.' }, $unset: { leaseToken: 1, leaseUntil: 1 } });
    throw error;
  } finally { clearInterval(heartbeat); }
  return Batch.findById(batch._id);
}
async function configure(req, id, body) {
  const metadata = await context(req.store._id);
  const before = await load(req, id);
  if (await Row.exists({ batchId: id, processed: true })) bad('Mapping cannot change after records have been committed. Start a new import for a different mapping.');
  const sheets = before.sheets.map(sheet => ({ ...sheet, selected: Array.isArray(body.sheets) && body.sheets.includes(sheet.name) }));
  if (!sheets.some(sheet => sheet.selected && sheet.total)) bad('Select at least one sheet containing product rows.');
  if (sheets.filter(sheet => sheet.selected).reduce((sum, sheet) => sum + sheet.total, 0) > 10000) bad('Select at most 10,000 product and variant rows per import.');
  if (!['create', 'update', 'upsert'].includes(body.mode)) bad('Choose an import mode.');
  if (body.mode !== 'create' && !(await require('../../utils/transaction').supportsTransactions())) bad('Bulk updates require MongoDB transactions (Atlas or a replica set). Create new drafts is available on this database.');
  safe(body.categoryMappings || {});
  for (const sheet of sheets.filter(sheet => sheet.selected)) {
    const mapping = body.mappings?.[sheet.name];
    if (!Array.isArray(mapping) || mapping.length !== sheet.headers.length) bad(`Map every column on ${sheet.name}, or explicitly ignore it.`);
    if (mapping.some(key => key !== '_ignore' && !metadata.fields.some(field => field.key === key))) bad('Choose a mapped field or Ignore for every column.');
    const fields = mapping.filter(key => key !== '_ignore');
    if (new Set(fields).size !== fields.length) bad('Two columns cannot map to the same field.');
  }
  const allowed = ['name', 'category', 'brand', 'sku', 'barcode', 'description', 'shortDescription', 'price', 'originalPrice', 'costPrice', 'stock', 'gstRate', 'hsnCode', 'warranty', 'attributeValues', 'variants', 'tags', 'colors', 'supplierName', 'supplierSku', 'shippingWeightKg', 'packageDimensions', 'countryOfOrigin', 'manufacturerDetails', 'highlights'];
  if (!Array.isArray(body.updateFields) || body.updateFields.some(key => !allowed.includes(key))) bad('Choose permitted update fields.');
  if (req.storeMember && body.mode !== 'create') {
    const { roleAllows } = require('../../models/StoreMember');
    if (body.updateFields.includes('stock') && !roleAllows(req.storeMember.role, 'inventory.write')) throw new ApiError('FORBIDDEN', 'Inventory write permission is required for bulk stock updates.');
    if (body.updateFields.includes('costPrice') && !roleAllows(req.storeMember.role, 'inventory.cost.read')) throw new ApiError('FORBIDDEN', 'Inventory cost permission is required for purchase-price updates.');
  }
  return edit(req, id, body, async batch => {
    await Batch.updateOne({ _id: id }, { $set: { sheets, mappings: body.mappings, mode: body.mode, updateFields: body.updateFields, categoryMappings: body.categoryMappings || {} } });
    let operations = [];
    const flush = async () => {
      if (!operations.length) return;
      if (!(await Batch.exists({ _id: id, leaseToken: batch.leaseToken }))) throw new ApiError('DUPLICATE_REQUEST', 'Import staging lease expired. Refresh and rebuild the preview.');
      await Row.bulkWrite(operations); operations = [];
    };
    for await (const row of Row.find({ batchId: id }).cursor()) {
      const sheet = sheets.find(item => item.name === row.sheet);
      if (!sheet.selected) operations.push({ updateOne: { filter: { _id: row._id }, update: { $set: { state: 'excluded', validationRevision: batch.revision, approved: false } } } });
      else {
      const mapped = mapRow(row, body.mappings[row.sheet]);
      mapped.issues = mapped.issues.map(item => ({ ...item, severity: 'parse' }));
      const rowKind = String(mapped.payload.rowKind || (mapped.payload.parentSku ? 'variant' : 'product')).toLowerCase();
      if (!['product', 'variant'].includes(rowKind)) mapped.issues.push(issue('rowKind', 'Row Type must be product or variant.', 'parse'));
      if (!mapped.payload.sku && rowKind === 'product' && body.mode !== 'update') mapped.payload.sku = `SC-${String(row._id).slice(-10).toUpperCase()}`;
      operations.push({ updateOne: { filter: { _id: row._id }, update: { $set: { ...mapped, rowKind, parentSku: String(mapped.payload.parentSku || ''), approved: false, processed: false, state: 'pending', provenance: [], candidates: [] }, $unset: { validationRevision: 1, result: 1, targetId: 1 } } } });
      }
      if (operations.length >= 250) await flush();
    }
    await flush();
  });
}
async function patchRows(req, id, body) {
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 100) bad('Edit up to 100 rows at a time.');
  for (const patch of body.rows) {
    if (!mongoose.isValidObjectId(patch.id) || !patch.values || typeof patch.values !== 'object' || Array.isArray(patch.values) || Object.keys(patch.values).some(key => !editable(key))) bad('Choose valid row edits.');
    if (JSON.stringify(patch.values).length > 80000) bad('A product row is too large.');
    Object.values(patch.values).forEach(value => safe(value));
    if (patch.clearFields && (!Array.isArray(patch.clearFields) || patch.clearFields.some(key => !editable(key)))) bad('Choose valid fields to clear.');
  }
  return edit(req, id, body, async () => {
    for (const patch of body.rows) {
      const row = await Row.findOne({ _id: patch.id, batchId: id, processed: false });
      if (!row) bad('A selected row was already processed or no longer exists.');
      row.issues = (row.issues || []).filter(item => item.severity !== 'parse' || !Object.hasOwn(patch.values, item.field));
      row.invalidValues ||= {};
      for (const [key, value] of Object.entries(patch.values)) {
        try {
          set(row.payload, key, blank(value) ? '' : convert(value, key)); delete row.invalidValues[key];
          if (blank(value)) row.provided = row.provided.filter(item => item !== key); else if (!row.provided.includes(key)) row.provided.push(key);
        } catch (error) { row.invalidValues[key] = value; row.issues.push(issue(key, error.message, 'parse')); }
      }
      row.markModified('invalidValues');
      row.markModified('payload'); row.approved = false; row.state = 'pending'; row.validationRevision = undefined;
      row.result = undefined;
      for (const source of row.provenance) if (Object.hasOwn(patch.values, source.field)) {
        source.verification = 'rejected'; source.manualOverride = true; source.reviewedBy = String(req.user._id); source.reviewedAt = new Date();
        row.markModified('provenance');
      }
      if (Object.keys(patch.values).length || patch.dismissEnrichment === true || patch.sourceId) row.issues = row.issues.filter(item => item.origin !== 'enrichment');
      if (patch.clearFields) row.clearFields = patch.clearFields;
      if (patch.sourceId) { if (!mongoose.isValidObjectId(patch.sourceId)) bad('Choose a valid source.'); row.selectedSourceId = patch.sourceId; row.enrichmentRequested = true; row.enrichmentDone = false; }
      if (patch.dismissEnrichment === true) {
        for (const source of row.provenance) if (source.verification === 'needs_review') {
          source.verification = 'rejected'; source.reviewedBy = String(req.user._id); source.reviewedAt = new Date();
          if (!source.conflict && !source.manualOverride) set(row.payload, source.field, source.previousValue || '');
        }
        row.markModified('provenance'); row.markModified('payload');
      }
      for (const review of patch.reviews || []) {
        const source = row.provenance[review.index];
        if (!source || !['verified', 'rejected'].includes(review.decision)) bad('Choose a valid source review.');
        if (review.decision === 'verified' && Object.hasOwn(patch.values, source.field) && String(patch.values[source.field]) !== String(source.value)) bad('The manual value conflicts with the source being accepted. Choose one value.');
        source.verification = review.decision; source.reviewedBy = String(req.user._id); source.reviewedAt = new Date();
        if (review.decision === 'verified') set(row.payload, source.field, source.value);
        else if (!source.conflict && !source.manualOverride) set(row.payload, source.field, source.previousValue || '');
        row.markModified('provenance'); row.markModified('payload');
      }
      const verified = new Map();
      for (const source of row.provenance.filter(item => item.verification === 'verified')) {
        if (verified.has(source.field) && verified.get(source.field) !== String(source.value)) bad('Conflicting sourced values cannot both be accepted. Reject one source.');
        verified.set(source.field, String(source.value));
      }
      await row.save();
    }
  }, body.rows.some(patch => patch.sourceId) ? { nextStatus: 'queued', job: 'enrich' } : {});
}
async function summary(id) {
  const groups = await Row.aggregate([{ $match: { batchId: new mongoose.Types.ObjectId(id) } }, { $group: { _id: '$state', count: { $sum: 1 } } }]);
  const counts = Object.fromEntries(groups.map(group => [group._id, group.count]));
  return { ...counts, total: groups.filter(group => group._id !== 'excluded').reduce((sum, group) => sum + group.count, 0) };
}
async function commit(req, id, body) {
  if (body.confirm !== true) bad('Approve the import preview before saving.');
  return edit(req, id, body, async batch => {
    const query = { batchId: id, processed: false, rowKind: 'product', state: { $in: ['ready', 'incomplete_draft'] }, $or: [{ operation: 'create' }, { state: 'ready' }], validationRevision: batch.revision - 1 };
    if (!body.all) { if (!Array.isArray(body.ids) || body.ids.some(value => !mongoose.isValidObjectId(value))) bad('Choose valid rows.'); query._id = { $in: body.ids }; }
    const count = await Row.countDocuments(query);
    if (!count) bad('Select ready or incomplete draft rows. Resolve invalid, duplicate and review rows first.');
    if (!body.all && count !== new Set(body.ids).size) bad('Some selected rows are not eligible. Resolve their issues or approve eligible rows only.');
    // Incomplete new products are safe drafts; updates must satisfy all current
    // rules before touching an existing catalog product.
    if (await Row.exists({ ...query, operation: 'update', state: 'incomplete_draft' })) bad('Existing product updates must be complete. Resolve missing fields first.');
    await Row.updateMany({ batchId: id, processed: false }, { $set: { approved: false } });
    await Row.updateMany(query, { $set: { approved: true } });
    await Batch.updateOne({ _id: id }, { $set: { job: 'commit', approvedAt: new Date(), approvedBy: req.user._id } });
    await logAudit({ req, action: 'PRODUCT_IMPORT_APPROVED', entityType: 'BulkProductImport', entityId: id, after: { count, mode: batch.mode, updateFields: batch.updateFields } });
  }, { nextStatus: 'queued', job: 'commit' });
}
module.exports = { context, batchScope, storeScope, load, upload, configure, patchRows, edit, commit, summary, busyStates, bad, Profile, Row, Batch, ensureReady };
