const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Settings = require('../models/Settings');
const Order = require('../models/Order');
const { ensureDefaultStore } = require('../services/storeService');
const { initializeBaldevStorePolicy, NO_RETURNS } = require('../services/baldevStorePolicy');
const { returnPolicySettings } = require('../services/returnWorkflowService');
const { returnEligibility } = require('../services/returnEligibilityService');
const { applyStorePresentation } = require('../services/storeSettingsValidation');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('migration updates only Baldev once, preserves delivery configuration and later admin choices', async () => {
  const store = await ensureDefaultStore();
  const saved = await Settings.create({ storeId: store._id, returnsEnabled: true, shippingFreeAboveEnabled: true, occasionShoppingEnabled: true, deliveryCharge: 75, localDeliveryFee: 35, localDeliveryRadiusKm: 8, shippingProvider: 'delhivery' });
  await Settings.collection.updateOne({ _id: saved._id }, { $unset: { storePolicyVersion: '' } });
  const other = await Settings.create({ storeId: new mongoose.Types.ObjectId(), storePolicyVersion: 0, returnsEnabled: true, shippingFreeAboveEnabled: true });
  await initializeBaldevStorePolicy(store);
  const current = await Settings.findById(saved._id).lean();
  for (const key of ['returnsEnabled', 'shippingFreeAboveEnabled', 'occasionShoppingEnabled', 'localDeliveryFreeAboveEnabled']) assert.equal(current[key], false, key);
  assert.equal(current.deliveryCharge, 75);
  assert.equal(current.localDeliveryFee, 35);
  assert.equal(current.localDeliveryRadiusKm, 8);
  assert.equal(current.shippingProvider, 'delhivery');
  assert.equal(current.returnPolicy, NO_RETURNS);
  assert.equal((await Settings.findById(other._id)).returnsEnabled, true);
  await Settings.updateOne({ _id: saved._id }, { $set: { returnsEnabled: true, deliveryCharge: 42 } });
  await initializeBaldevStorePolicy(store);
  const edited = await Settings.findById(saved._id);
  assert.equal(edited.returnsEnabled, true);
  assert.equal(edited.deliveryCharge, 42);
});

test('paid checkout charges above the old free threshold and rejects return and exchange requests', async () => {
  const store = await ensureDefaultStore();
  const saved = await setSettings({ storePolicyVersion: 0, shippingFreeAboveEnabled: true, deliveryCharge: 65, localDeliveryFee: 0 });
  await initializeBaldevStorePolicy(store);
  assert.equal((await Settings.findById(saved._id)).localDeliveryFee, 65);
  const customer = await createCustomer();
  const product = await createProduct({ price: 25000, stock: 3, sizingMode: 'free-size', sizes: [] });
  const created = await request('/api/orders', { method: 'POST', token: customer.token, body: { orderItems: [{ product: String(product._id), quantity: 1 }], paymentMethod: 'COD', shippingAddress: validAddress() } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.deliveryCharge, 65);
  const order = await Order.findById(created.data._id);
  assert.equal(order.returnPolicySnapshot.returnsEnabled, false);
  assert.equal(order.orderItems[0].returnable, false);
  assert.equal(order.orderItems[0].exchangeable, false);
  assert.equal(order.orderItems[0].returnWindowDays, 0);
  assert.equal(order.orderItems[0].returnPolicy, NO_RETURNS);
  order.orderStatus = 'Delivered'; order.deliveredAt = new Date(); await order.save();
  const eligibility = await request(`/api/returns/order/${order._id}`, { token: customer.token });
  assert.equal(eligibility.status, 200);
  assert.equal(eligibility.data.returnsEnabled, false);
  assert.equal(eligibility.data.deadline, null);
  assert.equal(eligibility.data.items[0].canRequest, false);
  for (const type of ['return', 'exchange']) {
    const result = await request('/api/returns', { method: 'POST', token: customer.token, body: { order: String(order._id), orderItemId: String(order.orderItems[0]._id), product: String(product._id), type, reason: 'Changed my mind', refundMethod: 'MANUAL' } });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.match(result.data.message, /disabled for this store/i);
  }
  const payment = await request('/api/settings/payment-methods?amount=25000');
  assert.equal(payment.data.shippingFreeAboveEnabled, false);
  const discovery = await request('/api/storefront/home/discovery');
  assert.equal(discovery.data.occasionShoppingEnabled, false);
});

test('existing purchase snapshots and custom non-policy announcements remain intact', () => {
  const order = { orderStatus: 'Delivered', deliveredAt: new Date(), orderItems: [{ _id: 'item', quantity: 1 }], returnPolicySnapshot: { capturedAt: new Date(), returnsEnabled: true, returnWindowDays: 7 } };
  assert.equal(returnEligibility(order, [], returnPolicySettings(order, { returnsEnabled: false })).items[0].canReturn, true);
  const oldTheme = { header: { announcementText: 'Free Shipping Above 999 · Easy Returns' }, footer: {} };
  assert.match(applyStorePresentation(oldTheme, { returnsEnabled: false, shippingFreeAboveEnabled: false }).header.announcementText, /charges apply/);
  assert.equal(applyStorePresentation({ ...oldTheme, header: { announcementText: 'New TVs are here' } }, {}).header.announcementText, 'New TVs are here');
});

test('policy migration version cannot be changed through admin settings', async () => {
  const admin = await createAdmin();
  await setSettings();
  const result = await request('/api/admin/settings', { method: 'PUT', token: admin.token, body: { storePolicyVersion: 0 } });
  assert.equal(result.status, 403);
});
