const mongoose = require('mongoose');
const storeId = require('../../models/plugins/storeId');
const mixed = mongoose.Schema.Types.Mixed;

const batchSchema = new mongoose.Schema({
  fileName: String, fileHash: String, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, lastActor: mongoose.Schema.Types.ObjectId,
  authorization: { type: mixed, select: false },
  status: { type: String, enum: ['mapping', 'editing', 'validating', 'preview', 'queued', 'processing', 'completed', 'completed_with_errors', 'cancelled', 'cleared', 'cleanup_failed'], default: 'mapping', index: true },
  sheets: [mixed], mappings: mixed, categoryMappings: { type: mixed, default: {} },
  mode: { type: String, enum: ['create', 'update', 'upsert'], default: 'create' },
  updateFields: { type: [String], default: [] }, revision: { type: Number, default: 0 },
  job: { type: String, enum: ['validate', 'commit', 'enrich', 'cleanup'], default: 'validate' },
  cleanup: mixed,
  provider: { type: String, default: 'gemini' }, allowWeb: { type: Boolean, default: false },
  allowCatalog: { type: Boolean, default: false },
  leaseToken: String, leaseUntil: Date, cancelRequested: { type: Boolean, default: false },
  approvedAt: Date, finishedAt: Date, lastError: String,
  jobTotal: Number, jobDone: { type: Number, default: 0 },
  summary: { type: mixed, default: {} },
}, { timestamps: true });
batchSchema.plugin(storeId);
batchSchema.index({ storeId: 1, createdAt: -1 });
batchSchema.index({ status: 1, leaseUntil: 1 });

const rowSchema = new mongoose.Schema({
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'BulkProductImport', required: true },
  sheet: String, rowNumber: Number, raw: [mixed], payload: { type: mixed, default: {} },
  invalidValues: { type: mixed, default: {} },
  provided: [String], clearFields: [String], rowKind: { type: String, default: 'product' }, parentSku: String,
  state: { type: String, default: 'pending', index: true }, issues: { type: [mixed], default: [] },
  targetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, targetUpdatedAt: Date,
  targetDraftId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductDraft' }, draftId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductDraft' },
  operation: String, approved: { type: Boolean, default: false }, processed: { type: Boolean, default: false }, cleanup: mixed,
  result: mixed, provenance: { type: [mixed], default: [] }, candidates: { type: [mixed], default: [] },
  enrichmentRequested: { type: Boolean, default: false }, enrichmentDone: { type: Boolean, default: false },
  selectedSourceId: mongoose.Schema.Types.ObjectId, baseline: mixed,
  validationRevision: Number,
}, { timestamps: true, minimize: false });
rowSchema.plugin(storeId);
rowSchema.index({ batchId: 1, sheet: 1, rowNumber: 1 }, { unique: true });
rowSchema.index({ batchId: 1, processed: 1, approved: 1 });
rowSchema.index({ batchId: 1, state: 1, _id: 1 });

const profileSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 100 }, mappings: mixed, headers: mixed, synonyms: mixed,
  createdBy: mongoose.Schema.Types.ObjectId,
}, { timestamps: true });
profileSchema.plugin(storeId);
profileSchema.index({ storeId: 1, name: 1 }, { unique: true });

const identitySchema = new mongoose.Schema({ storeId: mongoose.Schema.Types.ObjectId, key: String, owner: String, expiresAt: Date });
identitySchema.index({ storeId: 1, key: 1 }, { unique: true });
identitySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  Batch: mongoose.model('BulkProductImport', batchSchema),
  Row: mongoose.model('BulkProductImportRow', rowSchema),
  Profile: mongoose.model('ProductImportProfile', profileSchema),
  Identity: mongoose.model('ProductImportIdentity', identitySchema),
};
