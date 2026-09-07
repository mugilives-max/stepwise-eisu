'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHarness } = require('./gas-harness.cjs');

test('editor-only native family check stays in fresh books and produces only sanitized evidence', () => {
  const h = createHarness({ iterations: 10 });
  const c = h.context();
  const before = JSON.stringify([...h.spreadsheet.sheets].map(([name, sheet]) => [name, sheet.values]));
  const Spreadsheet = h.spreadsheet.constructor;
  const Range = h.spreadsheet.getSheetByName('config').getRange(1, 1).constructor;
  Range.prototype.getFormulas = function() { return this.getValues().map(r => r.map(() => '')); };
  const created = [];
  c.SpreadsheetApp.create = name => {
    const book = new Spreadsheet();
    book.getId = () => 'synthetic-native-family-book-' + created.indexOf(book);
    book.getUrl = () => 'https://example.invalid/synthetic/' + book.getId();
    book.testName = name;created.push(book);return book;
  };
  vm.runInContext(fs.readFileSync(require.resolve('./gas-native-family-check.gs'), 'utf8'), c);
  const result = c.stepwiseNativeFamilyCheck();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(created.length, 2);
  assert.ok(Object.keys(result.checks).length >= 40);
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.equal(h.effects.some(e => ['email', 'calendar'].includes(e.kind)), false);
  assert.equal(JSON.stringify(result).includes('fc1.'), false);
  assert.equal(JSON.stringify(result).includes('fa1.'), false);
  assert.equal(JSON.stringify([...h.spreadsheet.sheets].map(([name, sheet]) => [name, sheet.values])), before);
  assert.equal(c.ss_(), h.spreadsheet);
});
