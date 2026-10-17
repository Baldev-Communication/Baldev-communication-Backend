const router = require('express').Router();
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { asyncHandler } = require('../middleware/validate');
const { normalizeIndianMobile } = require('../utils/phoneUtils');

router.use(protect);

router.get('/', (req, res) => res.json(req.user.addresses || []));

router.patch('/:addressId/location', asyncHandler(async (req, res) => {
  require('../utils/validators').requireObjectId(req.params.addressId, 'address id');
  const current = req.user.addresses.id(req.params.addressId);
  if (!current) return res.status(404).json({ message: 'Address not found' });
  const point = require('../services/localDeliveryService').locationPoint(req.body.location);
  if (!point) throw new (require('../utils/apiError').ApiError)('VALIDATION_ERROR', 'Choose a valid delivery location on the map.');
  const expected = req.body.expectedAddress || {};
  const fields = ['houseNo', 'area', 'city', 'state', 'pincode'];
  if (fields.some(key => typeof expected[key] !== 'string' || expected[key].trim() !== String(current[key] || (key === 'houseNo' ? current.houseNumber : '') || '').trim())) {
    throw new (require('../utils/apiError').ApiError)('DUPLICATE_REQUEST', 'This address changed. Reload it before confirming a delivery pin.');
  }
  const match = { _id: current._id, ...Object.fromEntries([...fields, 'houseNumber'].map(key => [key, current[key] === undefined ? { $exists: false } : current[key]])) };
  const saved = await User.findOneAndUpdate({ _id: req.user._id, addresses: { $elemMatch: match } }, { $set: { 'addresses.$.location': point } }, { new: true, runValidators: true });
  if (!saved) throw new (require('../utils/apiError').ApiError)('DUPLICATE_REQUEST', 'This address changed. Reload it before confirming a delivery pin.');
  res.json(saved.addresses);
}));

router.post('/', asyncHandler(async (req, res) => {
  const error = validateAddress(req.body);
  if (error) return res.status(400).json({ message: error });
  if (req.body.isDefault || !req.user.addresses.length) req.user.addresses.forEach((address) => { address.isDefault = false; });
  req.user.addresses.push(normalizeAddress(req.body, req.body.isDefault || !req.user.addresses.length));
  await req.user.save();
  res.status(201).json(req.user.addresses);
}));

router.put('/:addressId', asyncHandler(async (req, res) => {
  const error = validateAddress(req.body);
  if (error) return res.status(400).json({ message: error });
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) return res.status(404).json({ message: 'Address not found' });
  if (req.body.location === undefined && ['houseNo', 'area', 'city', 'state', 'pincode'].some(key => String(req.body[key] || (key === 'houseNo' ? req.body.houseNumber : '') || '').trim() !== String(address[key] || (key === 'houseNo' ? address.houseNumber : '') || '').trim())) address.location = undefined;
  if (req.body.isDefault) req.user.addresses.forEach((item) => { item.isDefault = false; });
  Object.assign(address, normalizeAddress(req.body, req.body.isDefault));
  if (!req.user.addresses.some((item) => item.isDefault)) req.user.addresses[0].isDefault = true;
  await req.user.save();
  res.json(req.user.addresses);
}));

router.delete('/:addressId', asyncHandler(async (req, res) => {
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) return res.status(404).json({ message: 'Address not found' });
  address.deleteOne();
  if (req.user.addresses.length && !req.user.addresses.some((item) => item.isDefault)) req.user.addresses[0].isDefault = true;
  await req.user.save();
  res.json(req.user.addresses);
}));

router.patch('/:addressId/default', asyncHandler(async (req, res) => {
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) return res.status(404).json({ message: 'Address not found' });
  req.user.addresses.forEach((item) => { item.isDefault = String(item._id) === String(address._id); });
  await req.user.save();
  res.json(req.user.addresses);
}));

function normalizeAddress(data = {}, isDefault = false) {
  const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const mobile = normalizeIndianMobile(data.mobile || data.phone);
  const point = data.location === undefined || data.location === null ? null : require('../services/localDeliveryService').locationPoint(data.location);
  if (data.location !== undefined && data.location !== null && !point) throw new (require('../utils/apiError').ApiError)('VALIDATION_ERROR', 'Choose a valid delivery location on the map.');
  return {
    fullName: text(data.fullName),
    mobile,
    phone: mobile,
    alternateMobile: normalizeIndianMobile(data.alternateMobile),
    pincode: text(data.pincode),
    state: text(data.state),
    city: text(data.city),
    houseNo: text(data.houseNo || data.houseNumber),
    houseNumber: text(data.houseNo || data.houseNumber),
    area: text(data.area),
    landmark: text(data.landmark),
    addressType: text(data.addressType) || 'Home',
    isDefault,
    ...(data.location !== undefined ? { location: point || undefined } : {}),
  };
}

function validateAddress(data) {
  data = normalizeAddress(data);
  if (!data.fullName) return 'Full name is required';
  const mobile = data.mobile || data.phone;
  if (!/^[6-9]\d{9}$/.test(String(mobile || ''))) return 'Valid 10-digit mobile number is required';
  if (!/^\d{6}$/.test(String(data.pincode || ''))) return 'Valid 6-digit pincode is required';
  if (!data.state) return 'State is required';
  if (!data.city) return 'City is required';
  if (!data.houseNo && !data.houseNumber) return 'House/building is required';
  if (!data.area) return 'Area/colony is required';
  if (data.alternateMobile && !/^[6-9]\d{9}$/.test(data.alternateMobile)) return 'Valid alternate mobile number is required';
  if (!['Home', 'Work', 'Other'].includes(data.addressType)) return 'Choose Home, Work or Other for the address type';
  return '';
}

module.exports = router;
