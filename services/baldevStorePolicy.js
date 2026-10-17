const Settings = require('../models/Settings');

const VERSION = 1;
const NO_RETURNS = 'Returns and exchanges are not offered. Contact the store for product or warranty support.';
const PAID_DELIVERY = 'Delivery charges apply and are confirmed at checkout.';

// Apply this owner's policy once, before accepting requests. Future Settings
// edits remain authoritative, and other sellers keep their own policies.
async function initializeBaldevStorePolicy(store) {
  if (store?.slug !== 'baldev-communication' || !store.isDefault) return;
  const tenant = { $or: [{ storeId: store._id }, { storeId: null }, { storeId: { $exists: false } }] };
  if (!await Settings.exists(tenant)) await Settings.create({ storeId: store._id, storePolicyVersion: 0 });
  const fee = { $cond: [{ $gt: ['$deliveryCharge', 0] }, '$deliveryCharge', 99] };
  await Settings.collection.updateMany({ $and: [tenant, { storePolicyVersion: { $ne: VERSION } }] }, [{ $set: {
    returnsEnabled: false,
    shippingFreeAboveEnabled: false,
    localDeliveryFreeAboveEnabled: false,
    occasionShoppingEnabled: false,
    deliveryCharge: fee,
    localDeliveryFee: { $cond: [{ $gt: ['$localDeliveryFee', 0] }, '$localDeliveryFee', fee] },
    returnPolicy: NO_RETURNS,
    shippingPolicy: PAID_DELIVERY,
    announcementText: PAID_DELIVERY,
    storePolicyVersion: VERSION,
    updatedAt: '$$NOW',
  } }]);
}

module.exports = { initializeBaldevStorePolicy, NO_RETURNS, PAID_DELIVERY };
