const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Settings = require('../models/Settings');
const Order = require('../models/Order');
const Product = require('../models/Product');
const origin = { latitude: 28.6139, longitude: 77.209 };
const near = { latitude: 28.62, longitude: 77.21 }, far = { latitude: 28.8, longitude: 77.4 };
const localSettings = { localDeliveryEnabled: true, localDeliveryOrigin: origin, localDeliveryRadiusKm: 5, localDeliveryFee: 35, localDeliveryEstimate: '60–90 minutes', platformFee: 0, gstRate: 0, shippingFreeAboveEnabled: false, deliveryCharge: 99 };
test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

async function fixture(overrides = {}) {
  const customer = await createCustomer(), admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  await setSettings({ ...localSettings, ...overrides });
  const body = { orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }], paymentMethod: 'COD', deliveryMethod: 'LOCAL', shippingAddress: validAddress({ mobile: customer.user.phone, location: near }) };
  return { customer, admin, product, body };
}

test('settings toggle local and existing delivery independently without clearing courier configuration', async () => {
  const { token } = await createAdmin();
  await setSettings({ shippingPickup: { city: 'Saved city' }, deliveryCharge: 75 });
  const invalid = await request('/api/admin/settings', { method: 'PUT', token, body: { localDeliveryEnabled: true } });
  assert.equal(invalid.status, 400);
  const enabled = await request('/api/admin/settings', { method: 'PUT', token, body: { localDeliveryEnabled: true, localDeliveryOrigin: origin, localDeliveryRadiusKm: 5, localDeliveryFee: 30, standardDeliveryEnabled: false } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.deliveryCharge, 75);
  assert.equal(enabled.data.shippingPickup.city, 'Saved city');
  const options = await request('/api/settings/payment-methods');
  assert.equal(options.data.delivery.local.radiusKm, 5);
  assert.equal(options.data.delivery.standardEnabled, false);
  const disabled = await request('/api/admin/settings', { method: 'PUT', token, body: { localDeliveryEnabled: false, standardDeliveryEnabled: true } });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
  assert.equal(disabled.data.localDeliveryOrigin.latitude, origin.latitude);
  assert.equal(disabled.data.localDeliveryFee, 30);
});

test('local quotes enforce the area and fee before COD stock changes; saved orders retain self delivery after settings change', async () => {
  const f = await fixture();
  const quote = await request('/api/orders/quote', { method: 'POST', token: f.customer.token, body: f.body });
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  assert.equal(quote.data.shipping.deliveryMethod, 'LOCAL');
  assert.equal(quote.data.totals.deliveryCharge, 35);
  assert.equal(quote.data.totals.finalAmount, 1035);
  for (const [body, expectedStatus] of [
    [{ ...f.body, shippingAddress: { ...f.body.shippingAddress, location: far }, expectedTotal: 1035 }, 400],
    [{ ...f.body, expectedTotal: 1 }, 409],
    [{ ...f.body, expectedTotal: undefined }, 409],
  ]) {
    const rejected = await request('/api/orders/cod', { method: 'POST', token: f.customer.token, body });
    assert.equal(rejected.status, expectedStatus, JSON.stringify(rejected.data));
    assert.equal((await Product.findById(f.product._id)).stock, 5);
    assert.equal(await Order.countDocuments({}), 0);
  }
  const placed = await request('/api/orders/cod', { method: 'POST', token: f.customer.token, body: { ...f.body, expectedTotal: 1035 } });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  assert.deepEqual(placed.data.shippingAddress.location, near);
  assert.equal(placed.data.shippingQuote.fulfillmentMode, 'SELF');
  await Settings.updateOne({}, { $set: { localDeliveryEnabled: false, localDeliveryFee: 90, shippingProvider: 'delhivery' } });
  const confirmed = await request(`/api/admin/orders/${placed.data._id}/status`, { method: 'PUT', token: f.admin.token, body: { orderStatus: 'Confirmed', revision: placed.data.revision || 0 } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  const details = await request(`/api/admin/orders/${placed.data._id}/delivery`, { token: f.admin.token });
  assert.equal(details.status, 200, JSON.stringify(details.data));
  assert.equal(details.data.selectedProvider.name, 'manual');
  assert.equal(details.data.manualDefaultMode, 'SELF');
  const saved = await Order.findById(placed.data._id);
  assert.equal(saved.deliveryCharge, 35);
  assert.equal(saved.shippingQuote.fulfillmentMode, 'SELF');
  const correction = await request(`/api/admin/orders/${placed.data._id}/shipping-address`, { method: 'PUT', token: f.admin.token, body: { reason: 'Correct building entrance', revision: saved.revision, shippingAddress: { ...f.body.shippingAddress, location: origin } } });
  assert.equal(correction.status, 200, JSON.stringify(correction.data));
  assert.equal(correction.data.deliveryCharge, 35);
});

test('outside-area customers can use enabled existing delivery; disabled methods and missing pins are rejected', async () => {
  const f = await fixture();
  const standard = await request('/api/orders/quote', { method: 'POST', token: f.customer.token, body: { ...f.body, deliveryMethod: 'STANDARD', shippingAddress: { ...f.body.shippingAddress, location: far } } });
  assert.equal(standard.status, 200, JSON.stringify(standard.data));
  assert.equal(standard.data.totals.deliveryCharge, 99);
  const existing = await request('/api/orders/cod', { method: 'POST', token: f.customer.token, body: { ...f.body, deliveryMethod: 'STANDARD', shippingAddress: { ...f.body.shippingAddress, location: far }, expectedTotal: 1099 } });
  assert.equal(existing.status, 201, JSON.stringify(existing.data));
  await Settings.updateOne({}, { $set: { standardDeliveryEnabled: false } });
  const correction = await request(`/api/admin/orders/${existing.data._id}/shipping-address`, { method: 'PUT', token: f.admin.token, body: { reason: 'Correct street', revision: existing.data.revision || 0, shippingAddress: { ...f.body.shippingAddress, area: 'Corrected street', location: far } } });
  assert.equal(correction.status, 200, JSON.stringify(correction.data));
  const disabled = await request('/api/orders/quote', { method: 'POST', token: f.customer.token, body: { ...f.body, deliveryMethod: 'STANDARD' } });
  assert.equal(disabled.status, 400);
  const missing = await request('/api/orders/quote', { method: 'POST', token: f.customer.token, body: { ...f.body, shippingAddress: { ...f.body.shippingAddress, location: undefined } } });
  assert.equal(missing.data.code, 'LOCAL_DELIVERY_LOCATION_REQUIRED');
  const legacyLocalOnly = await request('/api/orders/quote', { method: 'POST', token: f.customer.token, body: { ...f.body, deliveryMethod: undefined } });
  assert.equal(legacyLocalOnly.data.shipping.deliveryMethod, 'LOCAL');
});

test('a delivery pin is saved only to its owned unchanged address and is retained in address responses', async () => {
  const { token } = await createCustomer();
  const address = validAddress();
  const saved = await request('/api/user/addresses', { method: 'POST', token, body: address });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const id = saved.data[0]._id;
  const body = { location: near, expectedAddress: address };
  const pinned = await request(`/api/user/addresses/${id}/location`, { method: 'PATCH', token, body });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.data));
  assert.deepEqual(pinned.data[0].location, near);
  const stranger = await createCustomer();
  assert.equal((await request(`/api/user/addresses/${id}/location`, { method: 'PATCH', token: stranger.token, body })).status, 404);
  const stale = await request(`/api/user/addresses/${id}/location`, { method: 'PATCH', token, body: { ...body, expectedAddress: { ...address, area: 'Different street' } } });
  assert.equal(stale.status, 409);
  const moved = await request(`/api/user/addresses/${id}`, { method: 'PUT', token, body: { ...address, area: 'New area' } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data[0].location, undefined);
});

test('online payment reserves the server-calculated local fee and finalises the saved quote after local delivery is disabled', async t => {
  const previous = { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_local_delivery';
  process.env.RAZORPAY_KEY_SECRET = 'local_delivery_test_secret';
  t.after(() => {
    if (previous.id === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = previous.id;
    if (previous.secret === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = previous.secret;
  });
  const f = await fixture({ razorpayEnabled: true });
  const quote = await request('/api/orders/quote', { method: 'POST', token: f.customer.token, body: { ...f.body, paymentMethod: 'UPI' } });
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  const pending = await request('/api/payments/create-order', { method: 'POST', token: f.customer.token, body: { ...f.body, paymentMethod: 'UPI', expectedTotal: quote.data.totals.finalAmount } });
  assert.equal(pending.status, 200, JSON.stringify(pending.data));
  assert.equal(pending.data.amount, 103500);
  assert.equal((await Product.findById(f.product._id)).stock, 4);
  await Settings.updateOne({}, { $set: { localDeliveryEnabled: false, localDeliveryFee: 100 } });
  const paymentId = 'pay_local_delivery_test';
  const signature = require('node:crypto').createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${pending.data.razorpayOrderId}|${paymentId}`).digest('hex');
  const paid = await request('/api/payments/verify', { method: 'POST', token: f.customer.token, body: { razorpay_order_id: pending.data.razorpayOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  const saved = await Order.findOne({ razorpayOrderId: pending.data.razorpayOrderId });
  assert.equal(saved.paymentStatus, 'Paid');
  assert.equal(saved.deliveryCharge, 35);
  assert.equal(saved.shippingQuote.deliveryMethod, 'LOCAL');
});
