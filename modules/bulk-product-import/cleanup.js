const Product = require('../../models/Product');
const ProductDraft = require('../../models/ProductDraft');
const { Batch, Row } = require('./models');
const service = require('./service');
const { ApiError } = require('../../utils/apiError');
const { collectMedia, cleanupUnusedMedia } = require('../../services/mediaCleanupService');
const { logAudit } = require('../../services/auditService');

async function preview(req, id) {
  const batch = await service.load(req, id);
  const scope = (await service.context(batch.storeId)).scope;
  const rows = await Row.find({ batchId: batch._id, rowKind: 'product' }).select('draftId operation state result').lean();
  const draftIds = rows.map(row => row.draftId).filter(Boolean);
  const [drafts, products] = await Promise.all([
    ProductDraft.find({ ...service.batchScope(req), sourceImportBatchId: batch._id }).select('status publishedProductId').lean(),
    Product.find({ $and: [scope, { sourceDraftId: { $in: draftIds } }] }).select('_id').lean(),
  ]);
  return { fileName: batch.fileName, revision: batch.revision, confirmation: batch.fileName,
    drafts: drafts.filter(draft => !draft.publishedProductId).length,
    publishedProducts: products.length,
    invalidRows: rows.filter(row => ['invalid', 'failed', 'duplicate', 'needs_review'].includes(row.state)).length,
    rows: await Row.countDocuments({ batchId: batch._id, 'cleanup.status': { $ne: 'done' } }),
    updatedProducts: rows.filter(row => row.operation === 'update' || row.result?.kind === 'updated').length,
    transactions: await require('../../utils/transaction').supportsTransactions(),
  };
}

async function queue(req, id, body) {
  const batch = await service.load(req, id);
  if (body.confirm !== true || String(body.confirmation || '') !== batch.fileName) service.bad('Type the exact file name to confirm clearing this import.');
  if (body.includePublished !== undefined && typeof body.includePublished !== 'boolean') service.bad('Choose whether to include newly published products.');
  if (body.includePublished && !(await require('../../utils/transaction').supportsTransactions())) service.bad('Removing published products requires MongoDB transactions. Drafts and invalid rows can still be cleared.');
  return service.edit(req, id, body, async locked => {
    await Row.updateMany({ batchId: id, 'cleanup.status': { $in: ['failed', 'retained'] } }, { $set: { 'cleanup.status': 'pending' } });
    await Batch.updateOne({ _id: id, leaseToken: locked.leaseToken }, { $set: {
      'cleanup.requestedAt': batch.cleanup?.requestedAt || new Date(), 'cleanup.requestedBy': req.user._id,
      'cleanup.includePublished': body.includePublished === true,
    } });
    await logAudit({ req, action: 'PRODUCT_IMPORT_CLEAR_APPROVED', entityType: 'BulkProductImport', entityId: id,
      after: { fileName: batch.fileName, includePublished: body.includePublished === true } });
  }, { nextStatus: 'queued', job: 'cleanup' });
}

async function cleanupRow(row, batch, ctx, req) {
  const { invoke } = require('./worker');
  const child = overrides => Object.assign(Object.create(req), overrides);
  if (row.operation === 'update' || row.result?.kind === 'updated') return { status: 'retained', reason: 'Existing product update retained; cleanup does not roll back or delete pre-existing products.' };
  if (row.rowKind === 'variant') return { status: 'done', removedRows: 1 };
  let draft = row.draftId && await ProductDraft.findOne({ _id: row.draftId, ...ctx.scope });
  if (draft && (String(draft.sourceImportBatchId) !== String(batch._id) || String(draft.sourceImportRowId) !== String(row._id))) throw new ApiError('FORBIDDEN', 'This draft does not belong to the import row.');
  const product = row.draftId && await Product.findOne({ $and: [ctx.scope, { sourceDraftId: row.draftId }] });
  if (product && !batch.cleanup.includePublished) return { status: 'retained', reason: 'Published product retained. Enable published-product removal to delete it.', published: true };
  if (draft?.publishedProductId && !product && String(draft.publishedProductId) !== String(row.cleanup?.productId || '')) {
    // Only a missing product is acceptable here, never a product owned by a
    // different draft/store even if an old result contains its identifier.
    if (await Product.exists({ _id: draft.publishedProductId })) throw new ApiError('FORBIDDEN', 'Published product ownership does not match this import.');
  }
  // Persist recovery information before removal. A process restart can finish
  // media cleanup and count this row once even if its document was removed.
  const plan = { ...row.cleanup, status: 'pending', draftId: draft?._id || row.cleanup?.draftId,
    productId: product?._id || row.cleanup?.productId,
    media: [...row.cleanup?.media || [], ...collectMedia(draft || {}), ...collectMedia(product || {})] };
  await Row.updateOne({ _id: row._id }, { $set: { cleanup: plan } });
  if (product) {
    const deletion = require('../../services/productDeletionService');
    let productReq = child({ params: { id: String(product._id) }, body: {}, query: {} });
    const check = await deletion.preview(productReq);
    if (!check.transactions || check.blockers.length) throw new ApiError('PRODUCT_DELETE_BLOCKED', check.blockers.length ? check.blockers.map(item => item.label).join('; ') : 'MongoDB transactions are required.', { statusCode: 409 });
    if (!check.archived) {
      const archived = await Product.findOneAndUpdate({ _id: product._id, updatedAt: product.updatedAt }, { $set: { isArchived: true, isActive: false, deletedAt: new Date() } }, { new: true });
      if (!archived) throw new ApiError('PRODUCT_CHANGED', 'The product changed during cleanup. Retry the deletion review.', { statusCode: 409 });
      await logAudit({ req, action: 'PRODUCT_ARCHIVE', entityType: 'Product', entityId: product._id, after: { importCleanup: batch._id } });
    }
    const finalCheck = await deletion.preview(productReq);
    productReq.body = { confirm: finalCheck.confirmation, version: finalCheck.version };
    await deletion.permanentlyDelete(productReq);
  }
  if (draft) {
    if (!['archived', 'published'].includes(draft.status)) {
      await invoke(require('../../controllers/productDraftController').archiveDraft, child({ params: { id: String(draft._id) }, query: {}, body: {} }));
      draft = await ProductDraft.findById(draft._id);
    }
    if (draft) await invoke(require('../../controllers/productDraftController').deleteDraft, child({ params: { id: String(draft._id) }, query: { confirm: String(draft.name || draft._id).trim(), baseRevision: draft.revision }, body: {} }));
  }
  const mediaCleanup = await cleanupUnusedMedia(plan.media);
  if (mediaCleanup.failed.length) throw new ApiError('SERVICE_UNAVAILABLE', 'Records removed; some uploaded images need cleanup retry.');
  return { status: 'done', removedRows: 1, deletedDraft: Boolean(plan.draftId), deletedProduct: Boolean(plan.productId), mediaCleanup };
}

async function processCleanup(batch, owned, ctx, req) {
  const query = { batchId: batch._id, 'cleanup.status': { $nin: ['done', 'retained', 'failed'] } };
  if (batch.jobTotal === undefined) {
    batch.jobTotal = await Row.countDocuments(query);
    await Batch.updateOne(owned, { $set: { jobTotal: batch.jobTotal } });
  }
  const rows = await Row.find(query).sort({ rowKind: 1, _id: 1 }).limit(15).lean();
  for (const row of rows) {
    const current = await Batch.findOne(owned).select('cancelRequested');
    if (!current || current.cancelRequested) break;
    try {
      const result = await cleanupRow(row, batch, ctx, req);
      await Row.updateOne({ _id: row._id }, result.status === 'done'
        ? { $set: { cleanup: result, state: 'cleared', payload: {}, raw: [], invalidValues: {}, issues: [], provenance: [], candidates: [], approved: false, processed: true }, $unset: { result: 1, baseline: 1 } }
        : { $set: { cleanup: result, approved: false } });
    } catch (error) {
      await Row.updateOne({ _id: row._id }, { $set: { 'cleanup.status': 'failed', 'cleanup.message': String(error.message || 'Cleanup failed.').slice(0, 500), approved: false } });
    }
    await Batch.updateOne(owned, { $inc: { jobDone: 1 } });
    await new Promise(resolve => setImmediate(resolve));
  }
  const [remaining, groups] = await Promise.all([
    Row.exists(query),
    Row.aggregate([{ $match: { batchId: batch._id } }, { $group: { _id: '$cleanup.status', rows: { $sum: 1 }, drafts: { $sum: { $cond: ['$cleanup.deletedDraft', 1, 0] } }, products: { $sum: { $cond: ['$cleanup.deletedProduct', 1, 0] } } } }]),
  ]);
  const totals = { removedRows: 0, deletedDrafts: 0, deletedProducts: 0, retained: 0, failed: 0 };
  for (const group of groups) {
    if (group._id === 'done') { totals.removedRows = group.rows; totals.deletedDrafts = group.drafts; totals.deletedProducts = group.products; }
    else if (group._id === 'retained') totals.retained = group.rows;
    else if (group._id === 'failed') totals.failed = group.rows;
  }
  await Batch.updateOne(owned, { $set: { 'cleanup.summary': totals, summary: await service.summary(batch._id),
    status: remaining ? 'processing' : totals.failed ? 'cleanup_failed' : 'cleared', lastError: '',
    ...(!remaining ? { finishedAt: new Date(), jobDone: batch.jobTotal } : {}) } });
  if (!remaining) await logAudit({ req, action: 'PRODUCT_IMPORT_CLEARED', entityType: 'BulkProductImport', entityId: batch._id, after: totals });
}

module.exports = { preview, queue, processCleanup };
