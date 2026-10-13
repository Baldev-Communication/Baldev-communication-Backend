const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const RuntimeLicense = require('../models/RuntimeLicense');
const Product = require('../models/Product');
const commerceUsage = require('../services/commerceUsageService');

function signedEnvelope(privateKey, installationId) {
  const payload = Buffer.from(JSON.stringify({
    installationId, status: 'ACTIVE', plan: 'BASIC', validUntil: new Date(Date.now() + 60_000).toISOString(),
  })).toString('base64url');
  return { algorithm: 'Ed25519', payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url') };
}

function setup(t) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const values = {
    NODE_ENV: 'test', CONTROL_PLANE_URL: 'https://control.example', CLIENT_INSTALLATION_ID: 'current-installation',
    CLIENT_LICENSE_KEY: 'test-key', LICENSE_SIGNING_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(Product, 'countDocuments', async () => 0);
  t.mock.method(commerceUsage, 'monthlyUsage', async () => ({ ordersPerMonth: 0 }));
  const path = require.resolve('../services/controlPlaneClient');
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  return { privateKey, service: require(path) };
}

test('a different installation cannot supply the legacy cached licence', async (t) => {
  const { privateKey, service } = setup(t);
  const fresh = signedEnvelope(privateKey, 'current-installation');
  const lookups = [];
  t.mock.method(RuntimeLicense, 'findOne', (filter) => {
    lookups.push(filter);
    return { lean: async () => null };
  });
  let savedKey;
  t.mock.method(RuntimeLicense, 'findOneAndUpdate', async (filter) => { savedKey = filter.key; });
  const fetch = t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => fresh }));

  const status = await service.licenseStatus();
  assert.equal(status.status, 'ACTIVE');
  assert.equal(status.source, 'platform');
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(lookups, [
    { key: 'active:current-installation' },
    { key: 'active', installationId: 'current-installation' },
  ]);
  assert.equal(savedKey, 'active:current-installation');
});

test('an invalid cached licence is replaced by fresh validation', async (t) => {
  const { privateKey, service } = setup(t);
  const stale = signedEnvelope(privateKey, 'another-installation');
  const fresh = signedEnvelope(privateKey, 'current-installation');
  t.mock.method(RuntimeLicense, 'findOne', (filter) => ({
    lean: async () => filter.key === 'active:current-installation' ? stale : null,
  }));
  t.mock.method(RuntimeLicense, 'findOneAndUpdate', async () => null);
  const fetch = t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => fresh }));

  const status = await service.licenseStatus();
  assert.equal(status.status, 'ACTIVE');
  assert.equal(status.source, 'platform');
  assert.equal(fetch.mock.callCount(), 1);
  const cached = await service.licenseStatus();
  assert.equal(cached.source, 'cache');
  assert.equal(fetch.mock.callCount(), 1);
});

test('a valid legacy cache remains usable during the cache-key migration', async (t) => {
  const { privateKey, service } = setup(t);
  const legacy = signedEnvelope(privateKey, 'current-installation');
  t.mock.method(RuntimeLicense, 'findOne', (filter) => ({
    lean: async () => filter.key === 'active' ? legacy : null,
  }));
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('No remote call expected'); });

  const status = await service.licenseStatus();
  assert.equal(status.source, 'cache');
  assert.equal(fetch.mock.callCount(), 0);
});

test('an invalid remote signature still fails closed after a bad cache', async (t) => {
  const { privateKey, service } = setup(t);
  const wrongInstallation = signedEnvelope(privateKey, 'another-installation');
  t.mock.method(RuntimeLicense, 'findOne', (filter) => ({
    lean: async () => filter.key === 'active:current-installation' ? wrongInstallation : null,
  }));
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => wrongInstallation }));

  await assert.rejects(service.licenseStatus(), { errorCode: 'UNAUTHORIZED' });
});
