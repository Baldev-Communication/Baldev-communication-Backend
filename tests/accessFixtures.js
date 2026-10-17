const crypto = require('node:crypto');
const User = require('../models/User');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const { MASTER_OWNER_PHONE } = require('../config/masterOwner');
const { generateToken } = require('../utils/generateToken');
const { grantSellerMode } = require('../services/storeService');
const { createCustomer } = require('./factories');

// Represents an already verified owner session, without bypassing route guards.
async function createMasterOwner() {
  let user = await User.findOne({ phone: MASTER_OWNER_PHONE }).select('+masterSessionVersion');
  if (!user) user = await User.create({ name: 'Test Master Owner', phone: MASTER_OWNER_PHONE,
    role: 'admin', activeMode: 'admin', availableModes: ['customer', 'admin'], systemRole: 'MASTER_OWNER',
    isPhoneVerified: true, masterSessionVersion: crypto.randomUUID() });
  user.$locals.masterAuthenticated = true;
  return { user, token: generateToken(user) };
}

async function createProvisionedSeller(name = 'Riya Fashion') {
  const { user, token } = await createCustomer();
  // The client installation no longer provisions stores through POST /stores.
  // Provision isolated fixtures directly; upload requests still exercise the
  // real authentication, membership, permissions and storage routes.
  const store = await Store.create({ name, slug: `fixture-${crypto.randomUUID()}`, owner: user._id, whatsappNumber: user.phone,
    industry: 'fashion', catalogStructure: require('../config/industryPresets').getIndustryPreset('fashion'), status: 'PUBLISHED' });
  await StoreMember.create({ store: store._id, user: user._id, role: 'OWNER', status: 'ACTIVE' });
  await grantSellerMode(user._id);
  return { user, token, store: { ...store.toObject(), id: String(store._id) } };
}

module.exports = { createMasterOwner, createProvisionedSeller };
