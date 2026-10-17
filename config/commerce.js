// Rentals are an optional legacy module. Sales installations leave it disabled.
function rentalModuleEnabled() {
  return process.env.ENABLE_RENTAL_MODULE === 'true';
}

function effectiveCommerceMode(mode) {
  return rentalModuleEnabled() ? mode || 'SALE_ONLY' : 'SALE_ONLY';
}

function salesStructure(structure = {}) {
  return { ...structure, commerce: { ...structure.commerce, mode: effectiveCommerceMode(structure.commerce?.mode) } };
}

function requireRentalModule(_req, res, next) {
  if (rentalModuleEnabled()) return next();
  return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'This store supports product sales only.' });
}

module.exports = { rentalModuleEnabled, effectiveCommerceMode, salesStructure, requireRentalModule };
