const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { ApiError } = require('../utils/apiError');

const MAX_EDGE = 1600;
const TARGET_BYTES = 700 * 1024;

async function compressDraftUploads(files = []) {
  for (const file of files) {
    let source;
    let metadata;
    try {
      source = await fs.readFile(file.path);
      metadata = await sharp(source, { limitInputPixels: 25_000_000 }).metadata();
    } catch {
      throw new ApiError('VALIDATION_ERROR', 'A product photo is invalid or too large to process.', { statusCode: 400 });
    }
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
      throw new ApiError('VALIDATION_ERROR', 'Only JPG, PNG and WEBP product photos are supported.', { statusCode: 400 });
    }
    if (metadata.format === 'webp' && file.mimetype === 'image/webp' && /\.webp$/i.test(file.filename || '')
      && file.size <= TARGET_BYTES && Math.max(metadata.width || 0, metadata.height || 0) <= MAX_EDGE) continue;

    const target = file.path + '.optimized.webp';
    try {
      let output;
      for (const edge of [MAX_EDGE, 1280, 1024, 800]) {
        for (const quality of [78, 62, 48, 40]) {
          output = await sharp(source, { limitInputPixels: 25_000_000 })
            .rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
            .webp({ quality, effort: 4 }).toBuffer();
          if (output.length <= TARGET_BYTES) break;
        }
        if (output.length <= TARGET_BYTES) break;
      }
      await fs.writeFile(target, output);
      await fs.unlink(file.path);
      file.path = target;
      file.filename = path.basename(target);
      file.originalname = String(file.originalname || 'product').replace(/\.[^.]+$/, '') + '.webp';
      file.mimetype = 'image/webp';
      file.size = output.length;
    } catch {
      await fs.unlink(target).catch(() => {});
      throw new ApiError('IMAGE_COMPRESSION_FAILED', 'Could not optimize a product photo. Please try another image.', { statusCode: 400 });
    }
  }
}

module.exports = { compressDraftUploads };
