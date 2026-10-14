const fs = require('fs');
const path = require('path');
const { generateGeminiJson } = require('./geminiJson.service');
const { statedCatalogDetails } = require('./productImportContext.service');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function isVisionEnabled() {
  return Boolean(String(process.env.GEMINI_API_KEY || '').trim());
}

function mimeFromName(name = '') {
  const ext = path.extname(String(name)).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function localUploadPath(imageUrl = '') {
  const raw = String(imageUrl || '').split('?')[0];
  const match = raw.match(/\/uploads\/([^/?#]+)$/i);
  if (!match) return '';
  return path.join(__dirname, '..', 'uploads', match[1]);
}

function readImageFile(filePath = '') {
  const resolved = path.resolve(String(filePath || ''));
  if (!resolved || !fs.existsSync(resolved)) throw new Error('Product image could not be read');
  const buffer = fs.readFileSync(resolved);
  if (!buffer.length) throw new Error('Product image is empty');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image is too large to analyze');
  return { mimeType: mimeFromName(resolved), data: buffer.toString('base64') };
}

function resolveFetchUrl(imageUrl = '') {
  const raw = String(imageUrl || '').trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;

  // Prefer the running local API for relative /uploads paths.
  // PUBLIC_API_URL may point at production and would fail for local files.
  const localOrigin = `http://127.0.0.1:${process.env.SERVER_PORT || 5000}`;
  const configured = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  const origin = /localhost|127\.0\.0\.1/i.test(configured) || !configured ? (configured || localOrigin) : localOrigin;
  return `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

async function readImage(imageUrl = '') {
  const raw = String(imageUrl || '').trim();
  if (!raw) throw new Error('Image is required');

  const diskPath = localUploadPath(raw);
  if (diskPath && fs.existsSync(diskPath)) {
    const buffer = fs.readFileSync(diskPath);
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image is too large to analyze');
    return { mimeType: mimeFromName(diskPath), data: buffer.toString('base64') };
  }

  const absolute = resolveFetchUrl(raw);
  const response = await fetch(absolute, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Could not read the uploaded photo');
  const mimeType = (response.headers.get('content-type') || mimeFromName(absolute)).split(';')[0];
  if (!mimeType.startsWith('image/')) throw new Error('Only product photos can be analyzed');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image is too large to analyze');
  return { mimeType, data: buffer.toString('base64') };
}

function clip(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return items.map((item) => clip(item, 40)).filter(Boolean).slice(0, 8);
}

function buildPrompt(categories, subcategories, imageCount = 1) {
  const categoryNames = categories.map((item) => item.name).filter(Boolean).slice(0, 40);
  return [
    'You are a catalog assistant for an Indian online store. Products may include electronics, accessories, clothing or other goods.',
    `Look carefully at the ${imageCount > 1 ? `${imageCount} photos of the same product` : 'product photo'}. Identify the main product from what you see — do not use any filename.`,
    'Return JSON only.',
    'Rules:',
    '- name: short shoppable title from the visible product, including readable brand and model when present.',
    '- categoryName: pick the closest match from the store category list when possible.',
    '- subCategory: only if it clearly fits a listed subcategory, otherwise empty.',
    '- colors: visible product colors only.',
    '- pattern: visible finish, print or surface work. Leave empty if unclear.',
    '- fabric: only for textile products when visually likely. Leave empty for electronics or uncertain materials.',
    '- occasion: only for apparel or gifts when styling clearly suggests one. Leave empty otherwise.',
    '- tags: 2-6 short searchable words from what you see.',
    '- shortDescription: one line for the product card.',
    '- description: 1-2 sentences describing the visible product. No invented claims, price or stock.',
    '- brand and countryOfOrigin: only when clearly readable on the product or packaging; otherwise empty. Quote the exact visible text in fieldSources.',
    '- packageDimensions: only for explicitly printed packed parcel length, width and height. Convert to centimetres; never use image pixel dimensions or garment measurements.',
    '- shippingWeightKg: only for an explicitly printed packed parcel weight. Convert grams to kilograms.',
    '- confidence values must be numbers from 0 to 1. Use a lower score whenever a detail is uncertain.',
    '- Never guess price, stock, SKU, brand, package dimensions, packed weight or which sizes are available.',
    `Store categories: ${categoryNames.join(', ') || 'none'}.`,
    `Known subcategories: ${(subcategories || []).slice(0, 40).join(', ') || 'none'}.`,
    'JSON shape: {"name":"","brand":"","countryOfOrigin":"","packageDimensions":{"lengthCm":null,"widthCm":null,"heightCm":null},"shippingWeightKg":null,"fieldSources":{"brand":"","countryOfOrigin":"","packageDimensions":"","shippingWeightKg":""},"categoryName":"","subCategory":"","colors":[],"pattern":"","fabric":"","occasion":"","tags":[],"shortDescription":"","description":"","confidence":{"name":0,"category":0,"color":0,"pattern":0,"fabric":0,"occasion":0,"overall":0}}',
  ].join(' ');
}

async function callGemini({ images, categories, subcategories }) {
  const safeImages = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, 3);
  const prompt = buildPrompt(categories, subcategories, safeImages.length);
  return generateGeminiJson({
    parts: [{ text: prompt }, ...safeImages.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))],
    timeoutMs: 25000, temperature: 0.2,
  });
}

function matchCategory(categories, categoryName) {
  const needle = clip(categoryName, 80).toLowerCase();
  if (!needle) return null;
  return categories.find((item) => clip(item.name, 80).toLowerCase() === needle)
    || categories.find((item) => {
      const name = clip(item.name, 80).toLowerCase();
      return name.length >= 3 && (needle.includes(name) || name.includes(needle));
    })
    || null;
}

function confidenceValue(value, fallback = 0) {
  let number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number > 1 && number <= 100) number /= 100;
  return Math.max(0, Math.min(1, Math.round(number * 100) / 100));
}

function inferSizingMode(categoryName = '', name = '') {
  const garment = `${categoryName} ${name}`.toLowerCase();
  if (/\b(saree|dupatta|stole|scarf)\b/.test(garment)) return 'free-size';
  if (/\b(kurti|kurta|suit|dress|gown|lehenga|skirt|top|shirt|jumpsuit|pant|trouser)\b/.test(garment)) return 'sized';
  return 'confirm';
}

function normalizeVisionSuggestion(raw = {}, safeCategories = [], model = '') {
  const matched = matchCategory(safeCategories, raw.categoryName);
  const name = clip(raw.name, 120);
  if (!name) {
    throw new Error('Could not identify this product from the photo. Try a clearer front-facing product shot.');
  }
  const colors = asList(raw.colors);
  const stated = Object.fromEntries(['brand', 'countryOfOrigin', 'packageDimensions', 'shippingWeightKg']
    .map(key => [key, statedCatalogDetails(clip(raw.fieldSources?.[key]?.quote || raw.fieldSources?.[key], 240))]));
  const brand = clip(raw.brand, 120);
  const countryOfOrigin = clip(raw.countryOfOrigin, 120);
  const dimensions = raw.packageDimensions;
  const verifiedDimensions = stated.packageDimensions.packageDimensions;
  const keys = ['lengthCm', 'widthCm', 'heightCm'];
  const packageDimensions = verifiedDimensions && dimensions && keys.every(key => Number(dimensions[key]) > 0
    && Math.abs(Number(dimensions[key]) - verifiedDimensions[key]) < 0.11) ? verifiedDimensions : undefined;
  const weight = Number(raw.shippingWeightKg);
  const shippingWeightKg = stated.shippingWeightKg.shippingWeightKg && weight > 0
    && Math.abs(weight - stated.shippingWeightKg.shippingWeightKg) < 0.011 ? weight : undefined;
  const rawConfidence = raw.confidence && typeof raw.confidence === 'object' ? raw.confidence : {};
  const knownScores = [
    confidenceValue(rawConfidence.name, name ? 0.7 : 0),
    confidenceValue(rawConfidence.category, matched ? 0.7 : 0),
    confidenceValue(rawConfidence.color, colors.length ? 0.7 : 0),
    confidenceValue(rawConfidence.pattern, raw.pattern ? 0.65 : 0),
    confidenceValue(rawConfidence.fabric, raw.fabric ? 0.55 : 0),
    confidenceValue(rawConfidence.occasion, raw.occasion ? 0.55 : 0),
  ].filter((score) => score > 0);
  const computedOverall = knownScores.length
    ? knownScores.reduce((sum, score) => sum + score, 0) / knownScores.length
    : 0.45;
  const confidence = {
    name: confidenceValue(rawConfidence.name, name ? 0.7 : 0),
    category: confidenceValue(rawConfidence.category, matched ? 0.7 : 0),
    primaryColor: confidenceValue(rawConfidence.color, colors.length ? 0.7 : 0),
    pattern: confidenceValue(rawConfidence.pattern, raw.pattern ? 0.65 : 0),
    fabric: confidenceValue(rawConfidence.fabric, raw.fabric ? 0.55 : 0),
    occasion: confidenceValue(rawConfidence.occasion, raw.occasion ? 0.55 : 0),
    overall: confidenceValue(rawConfidence.overall, computedOverall),
  };

  return {
    suggestion: {
      name,
      ...(brand && stated.brand.brand?.toLowerCase() === brand.toLowerCase() ? { brand } : {}),
      ...(countryOfOrigin && stated.countryOfOrigin.countryOfOrigin?.toLowerCase() === countryOfOrigin.toLowerCase() ? { countryOfOrigin } : {}),
      ...(packageDimensions ? { packageDimensions } : {}),
      ...(shippingWeightKg ? { shippingWeightKg } : {}),
      categoryId: matched?._id ? String(matched._id) : '',
      categoryName: matched?.name || '',
      subCategory: clip(raw.subCategory, 80),
      colors,
      pattern: clip(raw.pattern, 80),
      fabric: clip(raw.fabric, 80),
      occasion: clip(raw.occasion, 80),
      tags: asList(raw.tags),
      shortDescription: clip(raw.shortDescription, 200),
      description: clip(raw.description, 800),
      sizingMode: inferSizingMode(matched?.name || raw.categoryName, name),
    },
    confidence,
    analysis: {
      source: 'gemini-vision',
      model: clip(model, 80),
      analyzedAt: new Date().toISOString(),
    },
  };
}

async function analyzeImages({ images, categories = [], subcategories = [] } = {}) {
  if (!isVisionEnabled()) {
    return {
      enabled: false,
      reason: 'Smart visual suggestions are not configured on the server.',
    };
  }

  const safeCategories = (Array.isArray(categories) ? categories : [])
    .map((item) => ({ _id: item?._id, name: clip(item?.name, 80) }))
    .filter((item) => item._id && item.name)
    .slice(0, 40);
  const safeSubcategories = (Array.isArray(subcategories) ? subcategories : [])
    .map((item) => clip(item, 80))
    .filter(Boolean)
    .slice(0, 40);
  const result = await callGemini({ images, categories: safeCategories, subcategories: safeSubcategories });
  return {
    enabled: true,
    ...normalizeVisionSuggestion(result.raw, safeCategories, result.model),
  };
}

exports.isVisionEnabled = isVisionEnabled;

exports.getQuickAddVisionStatus = () => ({
  enabled: isVisionEnabled(),
  reason: isVisionEnabled()
    ? 'Photo reading is on. Upload a product photo to identify name, category, colors and details.'
    : 'Photo reading is off. Add a free GEMINI_API_KEY in backend/.env, then restart the server.',
});

exports.analyzeQuickAddImage = async ({ imageUrl, categories = [], subcategories = [] } = {}) => {
  if (!isVisionEnabled()) return analyzeImages({ images: [], categories, subcategories });
  const image = await readImage(imageUrl);
  return analyzeImages({ images: [image], categories, subcategories });
};

exports.analyzeReelCandidateImages = async ({ imageUrls = [], categories = [], subcategories = [] } = {}) => {
  if (!isVisionEnabled()) return analyzeImages({ images: [], categories, subcategories });
  const images = await Promise.all((Array.isArray(imageUrls) ? imageUrls : []).slice(0, 3).map(readImage));
  if (!images.length) throw new Error('No candidate photos are available for smart analysis.');
  return analyzeImages({ images, categories, subcategories });
};

exports.analyzeReelCandidateFiles = async ({ filePaths = [], categories = [], subcategories = [] } = {}) => {
  if (!isVisionEnabled()) return analyzeImages({ images: [], categories, subcategories });
  const images = (Array.isArray(filePaths) ? filePaths : []).slice(0, 3).map(readImageFile);
  if (!images.length) throw new Error('No candidate photos are available for smart analysis.');
  return analyzeImages({ images, categories, subcategories });
};

exports.normalizeVisionSuggestion = normalizeVisionSuggestion;
