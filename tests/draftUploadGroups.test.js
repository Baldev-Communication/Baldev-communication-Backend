const test = require('node:test');
const assert = require('node:assert/strict');
const { draftUploadPlan } = require('../services/draftUploadGroups');

test('nine photos can be assigned to product groups of four, three and two', () => {
  const plan = draftUploadPlan({ groupMode: 'grouped', photoGroups: JSON.stringify([1, 1, 1, 1, 2, 2, 2, 3, 3]), groupDetails: '{}' }, 9);
  assert.deepEqual(plan.groups.map(group => group.indexes), [[0, 1, 2, 3], [4, 5, 6], [7, 8]]);
});

test('grouping rejects missing assignments and ambiguous model details', () => {
  assert.throws(() => draftUploadPlan({ groupMode: 'grouped', photoGroups: '[1,1]' }, 3), /Assign every photo/);
  assert.throws(() => draftUploadPlan({ groupMode: 'single', groupDetails: JSON.stringify({ 1: { model: 'iPhone 17' } }) }, 1), /Choose a category/);
  assert.throws(() => draftUploadPlan({ groupMode: 'single', groupDetails: JSON.stringify({ 1: { ram: '8' } }) }, 1), /exact model/);
});
