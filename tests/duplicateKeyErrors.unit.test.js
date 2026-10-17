const test = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler } = require('../middleware/errorMiddleware');

function handle(error) {
  let result;
  const res = { status(status) { this.statusCode = status; return this; }, json(body) { result = { status: this.statusCode, body }; return this; } };
  errorHandler({ code: 11000, ...error }, {}, res, () => {});
  return result;
}
for (const [key, label] of [['sku', /SKU/], ['barcode', /Barcode/], ['slug', /URL/], ['sourceDraftId', /already has a published product/]]) {
  test(`compound duplicate ${key} identifies the field instead of the store ID`, () => {
    const result = handle({ keyPattern: { storeId: 1, [key]: 1 }, keyValue: { storeId: 'private-store-id', [key]: 'private-value' } });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'DUPLICATE_KEY');
    assert.match(result.body.message, label);
    assert.doesNotMatch(result.body.message, /storeId|private-store-id|private-value/);
  });
}
test('duplicate errors without keyPattern use keyValue and keep the special return conflict', () => {
  assert.match(handle({ keyValue: { storeId: 'x', sku: 'y' } }).body.message, /SKU/);
  const result = handle({ keyPattern: { active: 1, orderItemId: 1 } });
  assert.equal(result.body.code, 'DUPLICATE_REQUEST');
  assert.match(result.body.message, /active return or exchange/);
});
