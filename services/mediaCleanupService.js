const fs = require('node:fs/promises');
const path = require('node:path');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const Category = require('../models/Category');
const Banner = require('../models/Banner');
const Campaign = require('../models/Campaign');
const Store = require('../models/Store');
const WebsiteTheme = require('../models/WebsiteTheme');
const SocialProductImport = require('../models/SocialProductImport');
const Order = require('../models/Order');
const Review = require('../models/Review');
const ReturnExchange = require('../models/ReturnExchange');
const { deleteImageFromR2, isR2Configured } = require('./r2Upload');
const { deleteFile, isCloudinaryConfigured } = require('./cloudinaryUpload');

const managedFields = [
  [Product, ['images.url', 'images.publicId', 'images.background.original.url', 'images.background.original.publicId',
    'images.background.edited.url', 'images.background.edited.publicId', 'variants.images.url', 'variants.images.publicId',
    'videos.url', 'videos.publicId', 'videos.thumbnail']],
  [ProductDraft, ['image', 'images.url', 'images.publicId', 'images.background.original.url', 'images.background.original.publicId',
    'images.background.edited.url', 'images.background.edited.publicId', 'variants.images.url', 'variants.images.publicId',
    'videos.url', 'videos.publicId', 'videos.thumbnail']],
  [Category, ['image', 'socialImage']],
  [Banner, ['image', 'tabletImage', 'mobileImage']],
  [Campaign, ['creative.image', 'creative.tabletImage', 'creative.mobileImage']],
  [SocialProductImport, ['images.url', 'images.publicId', 'videos.url', 'videos.publicId', 'videos.thumbnail']],
  [Order, ['orderItems.image']],
  [Review, ['photos']],
  [ReturnExchange, ['photos', 'customerEvidence.fileUrl', 'productSnapshot.image']],
];

function collectMedia(record) {
  const assets = [];
  const visit = (value, resourceType = 'image') => {
    if (!value) return;
    if (typeof value === 'string') { assets.push({ url: value, resourceType }); return; }
    if (Array.isArray(value)) { value.forEach(item => visit(item, resourceType)); return; }
    if (value.url) assets.push({ url: value.url, publicId: value.publicId, resourceType });
    if (value.thumbnail) visit(value.thumbnail);
    if (value.background) {
      visit(value.background.original);
      visit(value.background.edited);
    }
  };
  visit(record?.image);
  visit(record?.socialImage);
  visit(record?.tabletImage);
  visit(record?.mobileImage);
  visit(record?.images);
  visit(record?.videos, 'video');
  visit(record?.variants?.flatMap(variant => variant.images || []));
  const unique = new Map();
  assets.filter(asset => asset.url).forEach(asset => {
    if (!unique.has(asset.url) || (!unique.get(asset.url).publicId && asset.publicId)) unique.set(asset.url, asset);
  });
  return [...unique.values()];
}

function ownedR2Key(url) {
  const base = String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!base || !isR2Configured()) return '';
  try {
    const baseUrl = new URL(`${base}/`);
    const assetUrl = new URL(url);
    if (assetUrl.origin !== baseUrl.origin || !assetUrl.pathname.startsWith(baseUrl.pathname)) return '';
    const key = decodeURIComponent(assetUrl.pathname.slice(baseUrl.pathname.length));
    return key && !key.split('/').includes('..') ? key : '';
  } catch { return ''; }
}

function isLocalUpload(url) {
  try {
    let pathname = url;
    if (/^https?:\/\//i.test(url)) {
      const assetUrl = new URL(url);
      const configured = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
      const sameApi = configured && assetUrl.origin === new URL(configured).origin;
      const localDev = ['localhost', '127.0.0.1'].includes(assetUrl.hostname);
      if (!sameApi && !localDev) return false;
      pathname = assetUrl.pathname;
    }
    return pathname.startsWith('/uploads/') && !pathname.includes('..');
  } catch { return false; }
}

function providerFor(asset) {
  const url = String(asset?.url || '');
  if (ownedR2Key(url)) return 'r2';
  if (isCloudinaryConfigured() && asset?.publicId) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com'
        && parsed.pathname.startsWith(`/${process.env.CLOUDINARY_CLOUD_NAME}/`)) return 'cloudinary';
    } catch { /* not a Cloudinary URL */ }
  }
  if (isLocalUpload(url)) return 'local';
  return '';
}

async function hasReference(asset) {
  const values = [asset.url, asset.publicId].filter(Boolean);
  for (const [Model, fields] of managedFields) {
    if (await Model.exists({ $or: fields.map(field => ({ [field]: { $in: values } })) })) return true;
  }
  // Storefront configs are Mixed documents and can hold the same uploaded URL.
  for (const Model of [Store, WebsiteTheme]) {
    const fields = Model === Store ? 'logo storefrontDesign' : 'draftConfig publishedConfig scheduledConfig scheduledContent';
    const records = await Model.find({}).select(fields).lean();
    if (records.some(record => values.some(value => JSON.stringify(record).includes(JSON.stringify(value))))) return true;
  }
  return false;
}

async function deleteLocalUpload(url) {
  const pathname = /^https?:\/\//i.test(url) ? new URL(url).pathname : url;
  const root = path.resolve(__dirname, '..', 'uploads');
  const target = path.resolve(root, pathname.slice('/uploads/'.length));
  if (!target.startsWith(`${root}${path.sep}`)) return false;
  try { await fs.unlink(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function cleanupUnusedMedia(assets) {
  const result = { deleted: 0, shared: 0, skipped: 0, failed: [] };
  const unique = new Map();
  for (const asset of assets || []) if (asset?.url) unique.set(asset.url, asset);
  for (const asset of unique.values()) {
    const provider = providerFor(asset);
    if (!provider) { result.skipped += 1; continue; }
    try {
      if (await hasReference(asset)) { result.shared += 1; continue; }
      const removed = provider === 'r2' ? await deleteImageFromR2(ownedR2Key(asset.url))
        : provider === 'cloudinary' ? await deleteFile(asset.publicId, asset.resourceType || 'image')
          : await deleteLocalUpload(asset.url);
      if (removed) result.deleted += 1;
      else result.failed.push(asset.url);
    } catch (error) {
      result.failed.push(asset.url);
      console.error('Media cleanup failed:', asset.url, error);
    }
  }
  return result;
}

module.exports = { cleanupUnusedMedia, collectMedia, hasReference, ownedR2Key };
