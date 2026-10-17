const { ApiError } = require('../utils/apiError');

function locationPoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const valid = (number, limit) => ['number', 'string'].includes(typeof number) && String(number).trim() !== '' && Number.isFinite(Number(number)) && Math.abs(Number(number)) <= limit;
  if (!valid(value.latitude, 90) || !valid(value.longitude, 180)) return null;
  return { latitude: Number(value.latitude), longitude: Number(value.longitude) };
}

function distanceKm(first, second) {
  const radians = value => value * Math.PI / 180;
  const lat = radians(second.latitude - first.latitude);
  const lng = radians(second.longitude - first.longitude);
  const arc = Math.sin(lat / 2) ** 2 + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(lng / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(Math.max(0, 1 - arc)));
}

function publicDeliveryConfig(settings = {}) {
  return {
    standardEnabled: settings.standardDeliveryEnabled !== false,
    local: {
      enabled: settings.localDeliveryEnabled === true,
      radiusKm: Number(settings.localDeliveryRadiusKm ?? 5),
      fee: Number(settings.localDeliveryFee ?? settings.deliveryCharge ?? 99),
      freeAboveEnabled: settings.localDeliveryFreeAboveEnabled === true,
      freeAbove: Number(settings.localDeliveryFreeAbove ?? 999),
      estimate: String(settings.localDeliveryEstimate || ''),
      ...(settings.localDeliveryEnabled === true ? { origin: locationPoint(settings.localDeliveryOrigin) } : {}),
    },
  };
}

function selectedDeliveryMethod(settings, requested) {
  const method = requested === undefined || requested === '' ? (settings.standardDeliveryEnabled === false && settings.localDeliveryEnabled === true ? 'LOCAL' : 'STANDARD') : requested;
  if (!['LOCAL', 'STANDARD'].includes(method)) throw new ApiError('DELIVERY_METHOD_UNAVAILABLE', 'Choose an available delivery method.');
  if (method === 'LOCAL' && settings.localDeliveryEnabled !== true) throw new ApiError('DELIVERY_METHOD_UNAVAILABLE', 'Local delivery is currently disabled. Choose another available delivery method.');
  if (method === 'STANDARD' && settings.standardDeliveryEnabled === false) throw new ApiError('DELIVERY_METHOD_UNAVAILABLE', settings.localDeliveryEnabled ? 'Choose local delivery and confirm the delivery location.' : 'Delivery is currently unavailable. Please contact the store.');
  return method;
}

function localDeliveryQuote({ settings, address, amount }) {
  const origin = locationPoint(settings.localDeliveryOrigin);
  const destination = locationPoint(address?.location);
  if (!origin) throw new ApiError('LOCAL_DELIVERY_UNAVAILABLE', 'The store delivery location has not been configured. Please contact the store.');
  if (!destination) throw new ApiError('LOCAL_DELIVERY_LOCATION_REQUIRED', 'Confirm the delivery address on the map to check local delivery availability.');
  const radius = Number(settings.localDeliveryRadiusKm ?? 5);
  const distance = distanceKm(origin, destination);
  if (!Number.isFinite(radius) || radius <= 0 || distance > radius + 1e-9) throw new ApiError('LOCAL_DELIVERY_UNAVAILABLE', `This address is outside the store's ${radius} km local delivery area. Choose another available delivery method or address.`);
  const free = settings.localDeliveryFreeAboveEnabled === true && amount >= Number(settings.localDeliveryFreeAbove ?? 999);
  const charge = free ? 0 : Number(settings.localDeliveryFee ?? settings.deliveryCharge ?? 99);
  if (!Number.isFinite(charge) || charge < 0) throw new ApiError('LOCAL_DELIVERY_UNAVAILABLE', 'Local delivery pricing is unavailable. Please contact the store.');
  return {
    deliveryMethod: 'LOCAL', provider: 'manual', fulfillmentMode: 'SELF', serviceable: true,
    serviceName: 'Store local delivery', destinationPincode: address?.pincode,
    deliveryCharge: Math.round(charge * 100) / 100, pricingSource: free ? 'local-free-threshold' : 'local-fixed',
    distanceKm: Math.round(distance * 1000) / 1000, radiusKm: radius, origin,
    deliveryEstimate: String(settings.localDeliveryEstimate || ''), parcel: null,
  };
}

function normalizeLocalDeliverySettings(updates, current = {}) {
  const next = { standardDeliveryEnabled: true, localDeliveryEnabled: false, localDeliveryRadiusKm: 5, localDeliveryFee: 99, localDeliveryFreeAbove: 999, ...current, ...updates };
  const invalid = message => { throw new ApiError('SHIPPING_VALIDATION', message); };
  for (const key of ['standardDeliveryEnabled', 'localDeliveryEnabled', 'localDeliveryFreeAboveEnabled']) {
    if (updates[key] !== undefined && typeof updates[key] !== 'boolean') invalid('Delivery options must be enabled or disabled.');
  }
  for (const [key, min, max] of [['localDeliveryRadiusKm', 0.1, 50], ['localDeliveryFee', 0, 100000], ['localDeliveryFreeAbove', 0, 10000000]]) {
    if (updates[key] === undefined) continue;
    if (!['number', 'string'].includes(typeof updates[key]) || String(updates[key]).trim() === '' || !Number.isFinite(Number(updates[key])) || Number(updates[key]) < min || Number(updates[key]) > max) invalid(`${key} must be between ${min} and ${max}.`);
    updates[key] = Number(updates[key]);
  }
  if (updates.localDeliveryEstimate !== undefined) {
    if (typeof updates.localDeliveryEstimate !== 'string' || updates.localDeliveryEstimate.trim().length > 100) invalid('Keep the local delivery estimate under 100 characters.');
    updates.localDeliveryEstimate = updates.localDeliveryEstimate.trim();
  }
  if (updates.localDeliveryOrigin !== undefined) {
    if (updates.localDeliveryOrigin === null && next.localDeliveryEnabled !== true) updates.localDeliveryOrigin = null;
    else {
      const point = locationPoint(updates.localDeliveryOrigin);
      if (!point) invalid('Choose a valid store location on the map.');
      updates.localDeliveryOrigin = point;
    }
  }
  if (next.localDeliveryEnabled === true && !locationPoint(updates.localDeliveryOrigin ?? next.localDeliveryOrigin)) invalid('Set the store location before enabling local delivery.');
  return updates;
}

module.exports = { locationPoint, distanceKm, publicDeliveryConfig, selectedDeliveryMethod, localDeliveryQuote, normalizeLocalDeliverySettings };
