const test = require('node:test');
const assert = require('node:assert/strict');
const { locationPoint, distanceKm, localDeliveryQuote, selectedDeliveryMethod, normalizeLocalDeliverySettings } = require('../services/localDeliveryService');
const { assertQuotedTotal, normalizeShippingSettings } = require('../services/shippingRules');
const { snapshotAddress } = require('../services/orderSnapshotService');
const { checkoutFingerprint } = require('../services/checkoutSafetyService');

const origin = { latitude: 28.6139, longitude: 77.209 };
const atKm = distance => ({ latitude: origin.latitude + distance / 6371.0088 * 180 / Math.PI, longitude: origin.longitude });
const settings = { localDeliveryEnabled: true, localDeliveryOrigin: origin, localDeliveryRadiusKm: 5, localDeliveryFee: 35, shippingFreeAboveEnabled: true, freeShippingMinAmount: 100 };

test('local location coordinates validate strictly, including valid zero coordinates', () => {
  assert.deepEqual(locationPoint({ latitude: 0, longitude: '0' }), { latitude: 0, longitude: 0 });
  for (const value of [null, {}, [], { latitude: null, longitude: 0 }, { latitude: '', longitude: 0 }, { latitude: true, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }]) assert.equal(locationPoint(value), null);
  assert.equal(distanceKm(origin, origin), 0);
});

test('only locations inside the exact radius qualify; local fees use their own free-delivery rule', () => {
  assert.ok(Math.abs(distanceKm(origin, atKm(4.999)) - 4.999) < 1e-8);
  const quote = localDeliveryQuote({ settings, address: { pincode: '110001', location: atKm(4.999) }, amount: 1000 });
  assert.equal(quote.deliveryCharge, 35);
  assert.equal(quote.fulfillmentMode, 'SELF');
  assert.equal(quote.deliveryMethod, 'LOCAL');
  assert.doesNotThrow(() => localDeliveryQuote({ settings, address: { location: atKm(5) }, amount: 1000 }));
  assert.throws(() => localDeliveryQuote({ settings, address: { location: atKm(5.001) }, amount: 1000 }), /outside/);
  assert.throws(() => localDeliveryQuote({ settings, address: { pincode: '110001' }, amount: 1000 }), /map/);
  const free = localDeliveryQuote({ settings: { ...settings, localDeliveryFreeAboveEnabled: true, localDeliveryFreeAbove: 1000 }, address: { location: atKm(1) }, amount: 1000 });
  assert.equal(free.deliveryCharge, 0);
});

test('delivery toggles preserve old defaults and allow only enabled methods', () => {
  assert.equal(selectedDeliveryMethod({}, undefined), 'STANDARD');
  assert.equal(selectedDeliveryMethod({ ...settings, standardDeliveryEnabled: false }, undefined), 'LOCAL');
  assert.throws(() => selectedDeliveryMethod({}, 'LOCAL'), /disabled/);
  assert.throws(() => selectedDeliveryMethod({ standardDeliveryEnabled: false }, 'STANDARD'), /unavailable/);
  assert.throws(() => selectedDeliveryMethod(settings, 'self'), /available/);
  assert.deepEqual(normalizeLocalDeliverySettings({ localDeliveryEnabled: false }, settings), { localDeliveryEnabled: false });
  assert.throws(() => normalizeLocalDeliverySettings({ localDeliveryEnabled: true }), /store location/);
  for (const updates of [{ localDeliveryRadiusKm: 0 }, { localDeliveryFee: -1 }, { localDeliveryEnabled: 'true' }, { localDeliveryOrigin: { latitude: null, longitude: null } }]) assert.throws(() => normalizeLocalDeliverySettings(updates), /location|between|enabled/);
  const updates = normalizeShippingSettings({ standardDeliveryEnabled: false, localDeliveryEnabled: true, localDeliveryOrigin: origin }, { shippingProvider: 'shiprocket' });
  assert.equal(updates.standardDeliveryEnabled, false, 'a disabled courier needs no new courier connection or pickup');
});

test('local checkout requires the quoted total and snapshots the chosen location', () => {
  const draft = { shippingQuote: { provider: 'manual', deliveryMethod: 'LOCAL' }, totals: { finalAmount: 1035 } };
  assert.throws(() => assertQuotedTotal(draft), /total has changed/);
  assert.throws(() => assertQuotedTotal(draft, 1000), /total has changed/);
  assert.doesNotThrow(() => assertQuotedTotal(draft, 1035));
  assert.deepEqual(snapshotAddress({ location: origin }).location, origin);
  assert.equal(Object.hasOwn(snapshotAddress({}), 'location'), false);
  assert.throws(() => snapshotAddress({ location: { latitude: 1000, longitude: 0 } }), /valid delivery location/);
  const body = { shippingAddress: { location: origin }, deliveryMethod: 'LOCAL' };
  assert.notEqual(checkoutFingerprint(body, 'COD'), checkoutFingerprint({ ...body, deliveryMethod: 'STANDARD' }, 'COD'));
  assert.notEqual(checkoutFingerprint(body, 'COD'), checkoutFingerprint({ ...body, shippingAddress: { location: atKm(1) } }, 'COD'));
});
