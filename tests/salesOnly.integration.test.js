const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Store = require('../models/Store');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Rental = require('../models/Rental');
const { ensureDefaultStore } = require('../services/storeService');
const { monthlyUsage } = require('../services/commerceUsageService');

process.env.ENABLE_RENTAL_MODULE = 'false';
test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('sales deployment rejects public, admin and seller rental APIs before authentication or booking', async () => {
  for (const [path, method] of [
    ['/api/rentals/configuration', 'GET'], ['/api/rentals/availability', 'GET'],
    ['/api/rentals/quote', 'POST'], ['/api/rentals/bookings', 'POST'],
    ['/api/admin/rentals/configuration', 'PUT'], ['/api/seller/rentals/configuration', 'PUT'],
  ]) {
    const response = await request(path, { method, ...(method === 'GET' ? {} : { body: { mode: 'SALE_AND_RENTAL' } }) });
    assert.equal(response.status, 404, JSON.stringify(response.data));
    assert.equal(response.data.code, 'NOT_FOUND');
  }
  assert.equal(await Rental.Booking.countDocuments({}), 0);
  assert.equal(await Rental.Configuration.countDocuments({}), 0);
});

async function legacyStore() {
  const store = await ensureDefaultStore();
  await Store.updateOne({ _id: store._id }, { $set: { salesEnabled: false, 'catalogStructure.commerce.mode': 'RENTAL_ONLY' } });
  await Rental.Configuration.updateOne({ storeId: store._id }, { $set: { mode: 'RENTAL_ONLY' } }, { upsert: true });
  return store;
}

test('stale rental settings cannot expose rental-only products or rental discovery in a sales storefront', async () => {
  const store = await legacyStore();
  const sale = await createProduct({ storeId: store._id, commerceMode: 'SALE_AND_RENTAL', isFeatured: true });
  const rental = await createProduct({ storeId: store._id, commerceMode: 'RENTAL_ONLY', isFeatured: true });
  for (const path of ['/api/settings', '/api/catalog-configuration', '/api/storefront/home/discovery']) {
    const response = await request(path);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    if (path.endsWith('catalog-configuration')) assert.equal(response.data.commerce.mode, 'SALE_ONLY');
    else if (path.endsWith('discovery')) {
      assert.equal(response.data.mode, 'SALE_ONLY');
      assert.equal(response.data.rentalEnabled, false);
    } else assert.equal(response.data.commerceMode, 'SALE_ONLY');
  }
  const catalog = await request('/api/products?includeFacets=true');
  assert.equal(catalog.status, 200, JSON.stringify(catalog.data));
  const products = Array.isArray(catalog.data) ? catalog.data : catalog.data.items;
  assert.ok(products.some(product => product._id === String(sale._id) && product.commerceMode === 'SALE_ONLY'));
  assert.equal(products.some(product => product._id === String(rental._id)), false);
  assert.equal((await request(`/api/products/${rental._id}`)).status, 404);
  const home = await request('/api/storefront/home');
  assert.equal(home.status, 200, JSON.stringify(home.data));
  assert.equal(home.data.settings.commerceMode, 'SALE_ONLY');
  assert.equal(JSON.stringify(home.data).includes(String(rental._id)), false);
  assert.ok(await Product.exists({ _id: rental._id }));
});

test('a former rental-only store can complete a normal sale and cannot sell separate rental stock', async () => {
  const store = await legacyStore();
  const customer = await createCustomer();
  const product = await createProduct({ storeId: store._id, commerceMode: 'SALE_AND_RENTAL', stock: 5 });
  await setSettings();
  const body = { orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }], paymentMethod: 'COD', shippingAddress: validAddress({ mobile: customer.user.phone }) };
  const quote = await request('/api/orders/quote', { method: 'POST', token: customer.token, body });
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  const placed = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: { ...body, expectedTotal: quote.data.totals.finalAmount } });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  assert.equal((await Product.findById(product._id)).stock, 4);
  const rental = await createProduct({ storeId: store._id, commerceMode: 'RENTAL_ONLY', stock: 7 });
  const rejected = await request('/api/orders/quote', { method: 'POST', token: customer.token, body: { ...body, orderItems: [{ product: String(rental._id), quantity: 1, size: 'M', color: 'Red' }] } });
  assert.equal(rejected.status, 403, JSON.stringify(rejected.data));
  assert.equal((await Product.findById(rental._id)).stock, 7);
  assert.equal(await Rental.Asset.countDocuments({}), 0);
});

test('rental product modes cannot bypass the sales-only API and old rental counts do not consume sales quota', async () => {
  const admin = await createAdmin();
  for (const commerceMode of ['RENTAL_ONLY', 'SALE_AND_RENTAL']) {
    const response = await request('/api/admin/products', { method: 'POST', token: admin.token, body: { name: 'Phone', commerceMode, images: [] } });
    assert.equal(response.status, 400, JSON.stringify(response.data));
    assert.match(response.data.message, /Only product sales/);
  }
  const count = test.mock.method(Rental.Booking, 'countDocuments', () => { throw new Error('Rental quota must not be queried'); });
  try {
    const usage = await monthlyUsage({ allStores: true });
    assert.equal(usage.rentalBookingsPerMonth, 0);
    assert.equal(usage.ordersPerMonth, usage.saleOrdersPerMonth);
    assert.equal(count.mock.callCount(), 0);
  } finally { count.mock.restore(); }
});

test('sales-only mode keeps prepaid checkout and repeated payment verification from deducting stock twice', async () => {
  const store = await legacyStore();
  const customer = await createCustomer();
  const product = await createProduct({ storeId: store._id, stock: 5, commerceMode: 'SALE_ONLY' });
  const previousId = process.env.RAZORPAY_KEY_ID, previousSecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_sales_only';
  process.env.RAZORPAY_KEY_SECRET = 'test_sales_only_secret';
  process.env.RAZORPAY_MOCK = '1';
  try {
    await setSettings({ razorpayEnabled: true, upiEnabled: true });
    const body = { orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }], paymentMethod: 'UPI', shippingAddress: validAddress({ mobile: customer.user.phone }) };
    const created = await request('/api/payments/create-order', { method: 'POST', token: customer.token, body });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal((await Product.findById(product._id)).stock, 4);
    const paymentId = 'pay_sales_only';
    const verification = { razorpay_order_id: created.data.razorpayOrderId, razorpay_payment_id: paymentId,
      razorpay_signature: crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${created.data.razorpayOrderId}|${paymentId}`).digest('hex') };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const paid = await request('/api/payments/verify', { method: 'POST', token: customer.token, body: verification });
      assert.equal(paid.status, 200, JSON.stringify(paid.data));
    }
    assert.equal((await Order.findById(created.data.orderId)).paymentStatus, 'Paid');
    assert.equal((await Product.findById(product._id)).stock, 4);
  } finally {
    if (previousId === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = previousId;
    if (previousSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = previousSecret;
  }
});
