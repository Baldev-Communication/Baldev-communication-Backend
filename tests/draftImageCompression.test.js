const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { compressDraftUploads } = require('../services/draftImageCompression');

test('draft photos are stored as bounded WebP and existing small WebP is left intact', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-compression-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const input = path.join(directory, 'product.jpg');
  await sharp({ create: { width: 2200, height: 1800, channels: 3, background: '#a12542' } }).jpeg({ quality: 95 }).toFile(input);
  const file = { path: input, filename: 'product.jpg', originalname: 'product.jpg', mimetype: 'image/jpeg', size: (await fs.stat(input)).size };
  await compressDraftUploads([file]);
  const stored = await fs.readFile(file.path);
  const metadata = await sharp(stored).metadata();
  assert.equal(file.mimetype, 'image/webp');
  assert.equal(file.originalname, 'product.webp');
  assert.equal(metadata.format, 'webp');
  assert.ok(Math.max(metadata.width, metadata.height) <= 1600);
  assert.equal(file.size, stored.length);
  const samePath = file.path;
  await compressDraftUploads([file]);
  assert.equal(file.path, samePath);
  assert.deepEqual(await fs.readFile(file.path), stored);
});

test('invalid image bytes fail before draft storage', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-compression-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const input = path.join(directory, 'invalid.jpg');
  await fs.writeFile(input, 'not an image');
  await assert.rejects(compressDraftUploads([{ path: input, originalname: 'invalid.jpg', mimetype: 'image/jpeg', size: 12 }]), error => error.errorCode === 'VALIDATION_ERROR');
});

test('busy photos are reduced below the draft storage target', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-compression-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const input = path.join(directory, 'detailed.jpg');
  await sharp(crypto.randomBytes(1200 * 1200 * 3), { raw: { width: 1200, height: 1200, channels: 3 } })
    .jpeg({ quality: 95 }).toFile(input);
  const before = (await fs.stat(input)).size;
  const file = { path: input, filename: 'detailed.jpg', originalname: 'detailed.jpg', mimetype: 'image/jpeg', size: before };
  await compressDraftUploads([file]);
  assert.ok(file.size < before);
  assert.ok(file.size <= 700 * 1024);
  assert.equal((await sharp(await fs.readFile(file.path)).metadata()).format, 'webp');
});
