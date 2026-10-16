const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createProduct } = require('./factories');
const Category = require('../models/Category');
const Banner = require('../models/Banner');
const { cleanupUnusedMedia, collectMedia, ownedR2Key } = require('../services/mediaCleanupService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('shared product and category upload stays until the last reference is removed', async () => {
  const name = `cleanup-${crypto.randomUUID()}.webp`;
  const url = `/uploads/${name}`;
  const file = path.join(__dirname, '..', 'uploads', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'test image');
  try {
    const product = await createProduct({ images: [{ url }] });
    const category = await Category.create({ name: 'Shared image', slug: 'shared-image', image: url });
    assert.deepEqual(collectMedia(product).map(asset => asset.url), [url]);
    await product.deleteOne();
    assert.equal((await cleanupUnusedMedia([{ url }])).shared, 1);
    assert.equal(await fs.readFile(file, 'utf8'), 'test image');
    await category.deleteOne();
    const result = await cleanupUnusedMedia([{ url }]);
    assert.equal(result.deleted, 1);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await fs.unlink(file).catch(() => null); }
});

test('collects variant, background and video assets for product cleanup', async () => {
  const record = {
    images: [{ url: '/uploads/cover.webp', background: { original: { url: '/uploads/original.webp' } } }],
    variants: [{ images: [{ url: '/uploads/variant.webp' }] }],
    videos: [{ url: '/uploads/clip.mp4', thumbnail: '/uploads/thumb.webp' }],
  };
  assert.deepEqual(new Set(collectMedia(record).map(asset => asset.url)), new Set([
    '/uploads/cover.webp', '/uploads/original.webp', '/uploads/variant.webp', '/uploads/clip.mp4', '/uploads/thumb.webp',
  ]));
  assert.equal(collectMedia(record).find(asset => asset.url.endsWith('clip.mp4')).resourceType, 'video');
});

test('R2 ownership check rejects lookalike hosts and paths', () => {
  const original = Object.fromEntries(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL']
    .map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test',
    R2_BUCKET_NAME: 'test', R2_PUBLIC_URL: 'https://images.example.com/media',
  });
  try {
    assert.equal(ownedR2Key('https://images.example.com/media/products/a.webp?version=1'), 'products/a.webp');
    assert.equal(ownedR2Key('https://images.example.com.evil.test/media/products/a.webp'), '');
    assert.equal(ownedR2Key('https://images.example.com/media-other/products/a.webp'), '');
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('banner replacement and permanent deletion remove only unshared uploads', async () => {
  const { token } = await createAdmin();
  const first = `banner-${crypto.randomUUID()}.webp`;
  const second = `banner-${crypto.randomUUID()}.webp`;
  const uploads = path.join(__dirname, '..', 'uploads');
  await fs.mkdir(uploads, { recursive: true });
  await Promise.all([first, second].map(name => fs.writeFile(path.join(uploads, name), 'image')));
  try {
    const banner = await Banner.create({ title: 'Seasonal offer', image: `/uploads/${first}` });
    const shared = await Category.create({ name: 'Banner shared', slug: 'banner-shared', image: `/uploads/${first}` });
    const updated = await request(`/api/admin/banners/${banner._id}`, {
      method: 'PUT', token, body: { title: banner.title, image: `/uploads/${second}` },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal(await fs.readFile(path.join(uploads, first), 'utf8'), 'image');
    await shared.deleteOne();
    const archived = await request(`/api/admin/banners/${banner._id}`, { method: 'DELETE', token });
    assert.equal(archived.status, 200);
    assert.equal(await fs.readFile(path.join(uploads, second), 'utf8'), 'image');
    const wrong = await request(`/api/admin/banners/${banner._id}/permanent`, { method: 'DELETE', token, body: { confirm: 'wrong' } });
    assert.equal(wrong.status, 400);
    const removed = await request(`/api/admin/banners/${banner._id}/permanent`, { method: 'DELETE', token, body: { confirm: banner.title } });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(removed.data.mediaCleanup.deleted, 1);
    assert.equal(await Banner.findById(banner._id), null);
    await assert.rejects(fs.stat(path.join(uploads, second)), { code: 'ENOENT' });
  } finally {
    await Promise.all([first, second].map(name => fs.unlink(path.join(uploads, name)).catch(() => null)));
  }
});

test('permanent product deletion removes its unreferenced upload after commit', async () => {
  const { token } = await createAdmin();
  const name = `product-${crypto.randomUUID()}.webp`;
  const file = path.join(__dirname, '..', 'uploads', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'image');
  try {
    const product = await createProduct({ isArchived: true, isActive: false, stock: 0, images: [{ url: `/uploads/${name}` }] });
    const preview = await request(`/api/admin/products/${product._id}/deletion-preview`, { token });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.eligible, true, JSON.stringify(preview.data));
    const removed = await request(`/api/admin/products/${product._id}/permanent`, {
      method: 'DELETE', token, body: { confirm: product.name, version: preview.data.version },
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(removed.data.mediaCleanup.deleted, 1);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await fs.unlink(file).catch(() => null); }
});
