const crypto = require('node:crypto');
const { Batch, Row, Identity } = require('./models');
const Product = require('../../models/Product');
const ProductDraft = require('../../models/ProductDraft');
const User = require('../../models/User');
const { context, summary } = require('./service');
const { validateRow, patchForUpdate, regex, issue } = require('./validation');
const { enrich } = require('./enrichment');
const { logAudit } = require('../../services/auditService');
const { ApiError } = require('../../utils/apiError');

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, set() { return this; }, json(data) { return this.statusCode >= 400 ? reject(new ApiError(data.code || 'VALIDATION_ERROR', data.message || 'Operation failed.', { statusCode: this.statusCode, details: data })) : resolve(data); } };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}
function middleware(handler, req) { return new Promise((resolve, reject) => { Promise.resolve(handler(req, {}, error => error ? reject(error) : resolve())).catch(reject); }); }
async function requestFor(batch, ctx, ai = false) {
  const user = await User.findById(batch.lastActor || batch.approvedBy || batch.createdBy).select('+masterSessionVersion');
  if (!user || user.isBlocked || user.role !== 'admin' || user.activeMode !== 'admin') throw new ApiError('FORBIDDEN', 'Import administrator is no longer authorized. Sign in and approve the batch again.');
  const owner = require('../../config/masterOwner');
  const master = batch.authorization?.kind === 'master' && owner.isOwnerAccount(user) && user.systemRole === 'MASTER_OWNER' && user.isPhoneVerified
    && batch.authorization.versionHash === crypto.createHash('sha256').update(String(user.masterSessionVersion || '')).digest('hex');
  if (!ctx.store.isDefault && !master) {
    const member = await require('../../models/StoreMember').findOne({ store: ctx.store._id, user: user._id, status: 'ACTIVE' });
    const { roleAllows } = require('../../models/StoreMember');
    if (!member || !roleAllows(member.role, 'catalog.write')) throw new ApiError('FORBIDDEN', 'Catalog permissions changed. Ask an authorized administrator to approve the import again.');
    if (batch.mode !== 'create' && batch.updateFields.includes('stock') && !roleAllows(member.role, 'inventory.write')) throw new ApiError('FORBIDDEN', 'Inventory write permission is required for bulk stock updates.');
    if (batch.mode !== 'create' && batch.updateFields.includes('costPrice') && !roleAllows(member.role, 'inventory.cost.read')) throw new ApiError('FORBIDDEN', 'Inventory cost permission is required for purchase-price updates.');
  }
  if (!master && ctx.store.catalogStructure?.clientPermissions?.catalog === false) throw new ApiError('FORBIDDEN', 'Catalog changes are disabled by the platform owner.');
  const req = { user, store: ctx.store, tenantFilter: ctx.scope, method: 'POST', originalUrl: ai ? '/api/admin/products/smart-fill' : '/api/admin/product-imports', path: '/product-imports', params: {}, body: {}, query: {}, get: () => undefined };
  await middleware(require('../../middleware/externalLicenseMiddleware'), req);
  await middleware(require('../../middleware/storeMiddleware').requireActiveStoreLicenseForWrites, req);
  if (ai) await middleware(require('../../middleware/storeMiddleware').requireStoreFeature('aiProduct'), req);
  return req;
}
async function groupVariants(row, batch, ctx) {
  const children = await Row.find({ batchId: batch._id, rowKind: 'variant', state: { $ne: 'excluded' }, parentSku: regex(row.payload.sku || '') }).sort({ sheet: 1, rowNumber: 1 }).lean();
  const errors = [];
  if (children.length) {
    if (row.provided?.includes('variants')) errors.push(issue('variants', 'Variants are supplied in both a JSON column and separate rows. Clear one source before importing.'));
    if (children.length > 200) errors.push(issue('variants', 'One product may contain at most 200 variants.'));
    row.payload.variants = children.map(child => {
      if (child.issues?.some(item => item.severity === 'parse')) errors.push(issue('variants', `Correct variant on ${child.sheet} row ${child.rowNumber}.`));
      if (child.payload.stock === undefined) errors.push(issue('variants', `Variant ${child.payload.sku || child.rowNumber} needs stock before publishing.`, 'missing'));
      return { sku: child.payload.sku, stock: child.payload.stock, price: child.payload.sellingPrice, originalPrice: child.payload.originalPrice, optionValues: child.payload.variantOptions || {} };
    });
    if (children.every(child => Number.isSafeInteger(child.payload.stock))) row.payload.stock = children.reduce((sum, child) => sum + child.payload.stock, 0);
  }
  const duplicateRow = row.payload.sku && await Row.exists({ batchId: batch._id, _id: { $ne: row._id }, state: { $ne: 'excluded' }, $or: [{ 'payload.sku': regex(row.payload.sku) }, { 'payload.variants.sku': regex(row.payload.sku) }] });
  if (duplicateRow) errors.push(issue('sku', 'This SKU appears more than once in the uploaded sheets.', 'duplicate'));
  const duplicateBarcode = row.payload.barcode && await Row.exists({ batchId: batch._id, _id: { $ne: row._id }, state: { $ne: 'excluded' }, 'payload.barcode': String(row.payload.barcode) });
  if (duplicateBarcode) errors.push(issue('barcode', 'This barcode appears more than once in the uploaded sheets.', 'duplicate'));
  const variantSkus = row.payload.variants?.map(variant => variant.sku).filter(Boolean) || [];
  if (variantSkus.length) {
    if (variantSkus.some(sku => String(sku).toLowerCase() === String(row.payload.sku || '').toLowerCase())) errors.push(issue('variants', 'A variant SKU must differ from its parent product SKU.', 'duplicate'));
    const conflict = await Product.findOne({ $and: [ctx.scope, { ...(row.targetId ? { _id: { $ne: row.targetId } } : {}), $or: [{ sku: { $in: variantSkus.map(regex) } }, { 'variants.sku': { $in: variantSkus.map(regex) } }] }] }).select('name sku');
    if (conflict) errors.push(issue('variants', `A variant SKU is already used by ${conflict.name}.`, 'duplicate'));
    for (const sku of variantSkus) {
      if (await Row.exists({ batchId: batch._id, _id: { $ne: row._id }, state: { $ne: 'excluded' }, $nor: [{ rowKind: 'variant', parentSku: regex(row.payload.sku || '') }], $or: [{ 'payload.variants.sku': regex(sku) }, { 'payload.sku': regex(sku) }] })) errors.push(issue('variants', `Variant SKU ${sku} is used by another parent in this import.`, 'duplicate'));
    }
  }
  return { children, errors };
}
function stateFor(issues, fallback) {
  if (issues.some(item => ['error', 'parse'].includes(item.severity))) return 'invalid';
  if (issues.some(item => item.severity === 'duplicate')) return 'duplicate';
  if (issues.some(item => item.severity === 'review')) return 'needs_review';
  if (issues.some(item => item.severity === 'missing')) return 'incomplete_draft';
  return fallback;
}
async function validate(row, batch, ctx) {
  if (row.rowKind === 'variant') {
    const parents = row.parentSku && await Row.find({ batchId: batch._id, rowKind: 'product', state: { $ne: 'excluded' }, 'payload.sku': regex(row.parentSku) }).select('_id').lean();
    const errors = [...row.issues.filter(item => item.severity === 'parse')];
    if (!row.payload.sku || !row.parentSku || !parents || parents.length !== 1 || !row.payload.variantOptions || Array.isArray(row.payload.variantOptions) || typeof row.payload.variantOptions !== 'object') errors.push(issue('parentSku', 'Variant rows need a unique SKU, exact Parent SKU in the selected sheets and a Variant Options JSON object.'));
    return { issues: errors, state: errors.length ? 'invalid' : 'variant', validationRevision: batch.revision };
  }
  // Resolve update identity before checking variant SKU ownership.
  const result = await validateRow(row, batch, ctx);
  row.targetId = result.targetId;
  const grouped = await groupVariants(row, batch, ctx);
  const final = grouped.children.length ? await validateRow({ ...row, payload: row.payload }, batch, ctx) : result;
  final.issues.push(...grouped.errors);
  final.state = stateFor(final.issues, final.state);
  final.payload = { ...final.payload, ...(grouped.children.length ? { variants: row.payload.variants, ...(row.payload.stock === undefined ? {} : { stock: row.payload.stock }) } : {}) };
  return final;
}
async function saveRow(row, batch, ctx, req) {
  const owner = `bulk:${batch._id}:${row._id}`;
  const keys = [...new Set([row.payload.sku && `sku:${row.payload.sku.toLowerCase()}`, row.payload.barcode && `barcode:${row.payload.barcode}`, ...(row.payload.variants || []).map(item => item.sku && `sku:${item.sku.toLowerCase()}`)].filter(Boolean))].sort();
  try {
    for (const key of keys) {
      try { await Identity.findOneAndUpdate({ storeId: batch.storeId, key, $or: [{ owner }, { expiresAt: { $lte: new Date() } }] }, { $set: { owner, expiresAt: new Date(Date.now() + 120000) } }, { upsert: true }); }
      catch (error) { if (error.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'Another import is saving this SKU or barcode. Retry after it finishes.'); throw error; }
    }
    return await saveOwnedRow(row, batch, ctx, req);
  } finally { await Identity.deleteMany({ storeId: batch.storeId, owner }); }
}
async function saveOwnedRow(row, batch, ctx, req) {
  const operation = `bulk:${batch._id}:${row._id}`;
  if (row.operation === 'update') {
    if (!(await require('../../utils/transaction').supportsTransactions())) throw new ApiError('SERVICE_UNAVAILABLE', 'Bulk updates require MongoDB transactions (Atlas or a replica set). New draft imports remain available.');
    const existing = await Product.findOne({ $and: [ctx.scope, { _id: row.targetId }] }).select('+lastBulkImportOperation').lean();
    if (!existing) throw new ApiError('NOT_FOUND', 'Product was removed after preview.');
    if (existing.lastBulkImportOperation === operation) return { kind: 'updated', productId: existing._id, recovered: true };
    if (existing.updatedAt.getTime() !== new Date(row.targetUpdatedAt).getTime()) throw new ApiError('INVENTORY_CHANGED', 'Product changed after preview. Validate and approve this row again.');
    const patch = patchForUpdate(row.payload, existing, batch.updateFields, row.clearFields);
    // Variants changed by the inventory service retain their stable IDs.
    const result = await invoke(require('../../controllers/productController').updateProduct, { ...req, method: 'PUT', params: { id: String(existing._id) }, body: { ...patch, inventoryRevision: existing.inventoryRevision || 0 }, importOperationId: operation, importExpectedUpdatedAt: existing.updatedAt });
    return { kind: 'updated', productId: result._id };
  }
  let draft = await ProductDraft.findById(row.draftId);
  if (!draft) {
    // Revalidate identifiers just before persistence; the deterministic draft
    // id and source-row unique index make interrupted retries converge.
    const checked = await validateRow(row, batch, ctx);
    if (!['ready', 'incomplete_draft'].includes(checked.state)) throw new ApiError('VALIDATION_ERROR', checked.issues[0]?.message || 'Row needs review.');
    const payload = { ...checked.payload }; for (const key of ['productId', 'currency', 'status', 'rowKind', 'parentSku', 'variantOptions']) delete payload[key];
    draft = await ProductDraft.findOneAndUpdate({ _id: row.draftId }, { $setOnInsert: { ...payload, _id: row.draftId, storeId: batch.storeId, sourceImportBatchId: batch._id, sourceImportRowId: row._id, sourceType: 'bulk-import', createdBy: batch.createdBy, status: 'draft', importContext: { provenance: row.provenance, fileName: batch.fileName, sheet: row.sheet, rowNumber: row.rowNumber } } }, { upsert: true, new: true, runValidators: true });
  }
  if (String(draft.sourceImportRowId) !== String(row._id) || String(draft.storeId) !== String(batch.storeId)) throw new ApiError('DUPLICATE_REQUEST', 'Draft retry identity conflicts with another record.');
  await logAudit({ req, action: 'PRODUCT_IMPORT_DRAFT_CREATED', entityType: 'ProductDraft', entityId: draft._id, after: { batchId: batch._id, row: row.rowNumber, sku: draft.sku } });
  return { kind: 'created', draftId: draft._id };
}
async function processOneBatch(id) {
  await require('./service').ensureReady();
  const token = crypto.randomUUID(), now = new Date();
  const batch = await Batch.findOneAndUpdate({ ...(id ? { _id: id } : {}), status: { $in: ['editing', 'validating', 'queued', 'processing'] }, $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: { $exists: false } }] }, { $set: { leaseToken: token, leaseUntil: new Date(Date.now() + 120000) } }, { new: true, sort: { updatedAt: 1 } }).select('+authorization').lean();
  if (!batch) return false;
  const owned = { _id: batch._id, leaseToken: token };
  const heartbeat = setInterval(async () => {
    try {
      const result = await Batch.updateOne(owned, { $set: { leaseUntil: new Date(Date.now() + 120000) } });
      if (result.matchedCount) await Identity.updateMany({ storeId: batch.storeId, owner: new RegExp(`^bulk:${batch._id}:`) }, { $set: { expiresAt: new Date(Date.now() + 120000) } });
    } catch { /* Lease recovery is persisted; failed renewal never acknowledges a row. */ }
  }, 20000); heartbeat.unref();
  try {
    if (batch.cancelRequested) { await Batch.updateOne(owned, { $set: { status: 'cancelled', finishedAt: new Date() } }); return true; }
    const ctx = await context(batch.storeId);
    const req = await requestFor(batch, ctx, batch.job === 'enrich' && batch.allowWeb);
    if (batch.status === 'editing') batch.job = 'validate';
    const query = { batchId: batch._id, processed: false, state: { $ne: 'excluded' } };
    if (batch.job === 'validate') query.validationRevision = { $ne: batch.revision };
    if (batch.job === 'commit') { query.approved = true; query.rowKind = 'product'; }
    if (batch.job === 'enrich') { query.enrichmentRequested = true; query.enrichmentDone = { $ne: true }; }
    if (batch.jobTotal === undefined) {
      batch.jobTotal = await Row.countDocuments(query);
      await Batch.updateOne(owned, { $set: { jobTotal: batch.jobTotal } });
    }
    const rows = await Row.find(query).sort({ _id: 1 }).limit(batch.job === 'enrich' ? 1 : 30).lean();
    if (batch.job !== 'validate') await Batch.updateOne(owned, { $set: { status: 'processing' } });
    for (const row of rows) {
      const current = await Batch.findOne(owned).select('cancelRequested');
      if (!current || current.cancelRequested) break;
      let update;
      try {
        if (batch.job === 'validate') update = await validate(row, batch, ctx);
        else if (batch.job === 'enrich') {
          const enriched = await enrich(row, batch, ctx);
          update = { ...enriched, enrichmentDone: true, approved: false, issues: enriched.warning ? [{ ...issue('enrichment', enriched.warning, 'review', 'Select an exact candidate, or continue with manually supplied details.'), origin: 'enrichment' }] : [] };
          delete update.warning;
          const checked = await validateRow({ ...row, ...update }, batch, ctx);
          update = { ...update, ...checked, candidates: [...checked.candidates, ...enriched.candidates] };
        } else {
          const result = await saveRow(row, batch, ctx, req);
          update = { processed: true, approved: false, result, state: result.kind === 'created' ? 'created_draft' : 'updated' };
          await Row.updateMany({ batchId: batch._id, rowKind: 'variant', parentSku: regex(row.payload.sku || ''), state: { $ne: 'excluded' } }, { $set: { processed: true, state: 'variant_imported', result: { kind: 'variant', parentRowId: row._id, ...result } } });
        }
      } catch (error) {
        update = { state: 'failed', approved: false, result: { kind: 'failed', message: String(error.message || 'Operation failed.').slice(0, 500) }, ...(batch.job === 'validate' ? { validationRevision: batch.revision } : {}), ...(batch.job === 'enrich' ? { enrichmentDone: true } : {}) };
      }
      await Row.updateOne({ _id: row._id, processed: false }, { $set: update });
      await Batch.updateOne(owned, { $inc: { jobDone: 1 } });
      await new Promise(resolve => setImmediate(resolve));
    }
    const remaining = await Row.exists(query);
    const counts = await summary(batch._id);
    const status = batch.job === 'commit' ? (counts.failed ? 'completed_with_errors' : 'completed') : 'preview';
    await Batch.updateOne(owned, { $set: { summary: counts, lastError: '', ...(remaining ? { status: batch.job === 'validate' ? 'validating' : 'processing' } : { status, finishedAt: new Date(), jobDone: batch.jobTotal }) } });
  } catch (error) {
    await Batch.updateOne(owned, { $set: { status: 'preview', lastError: String(error.message || 'Import paused.').slice(0, 500) } });
  } finally {
    clearInterval(heartbeat);
    await Batch.updateOne(owned, { $unset: { leaseToken: 1, leaseUntil: 1 } });
  }
  return true;
}
function startWorker() {
  let running = false, stopped = false;
  const tick = async () => { if (running || stopped) return; running = true; try { await processOneBatch(); } catch (error) { console.error('Bulk import worker:', error.message); } finally { running = false; } };
  const timer = setInterval(tick, 1000); timer.unref(); tick();
  return () => { stopped = true; clearInterval(timer); };
}
module.exports = { startWorker, processOneBatch, invoke, middleware, validate, saveRow };
