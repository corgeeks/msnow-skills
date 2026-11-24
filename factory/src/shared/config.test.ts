import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, parseConfig } from './config.ts';

test('missing file returns defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-config-'));
  assert.deepEqual(loadConfig(join(dir, 'nope.json')), DEFAULT_CONFIG);
});

test('partial input deep-merges', () => {
  const c = parseConfig({ caps: { sessionMinutes: 10 } });
  assert.equal(c.caps.sessionMinutes, 10);
  assert.equal(c.caps.sessionCostUsd, DEFAULT_CONFIG.caps.sessionCostUsd);
  assert.equal(c.port, DEFAULT_CONFIG.port);
});

test('unknown key throws with path', () => {
  assert.throws(() => parseConfig({ caps: { bogus: 1 } }), /caps\.bogus/);
});

test('wrong type throws with path', () => {
  assert.throws(() => parseConfig({ port: '80' }), /port/);
  assert.throws(() => parseConfig({ caps: { sessionMinutes: 'x' } }), /caps\.sessionMinutes/);
  assert.throws(() => parseConfig({ roles: { reviewer: { x: 1 } } }), /roles\.reviewer\.x/);
});

test('caps.itemCostUsd accepts sub-micro-dollar and non-whole-micro-dollar caps; rounding happens at comparison', () => {
  for (const v of [0.0000001, 0.0150001, 16384.000003]) assert.equal(parseConfig({ caps: { itemCostUsd: v } }).caps.itemCostUsd, v);
});

test('caps.itemCostUsd defaults to 2 and must be positive', () => {
  assert.equal(parseConfig({}).caps.itemCostUsd, 2);
  assert.equal(parseConfig({ caps: { itemCostUsd: 0.015 } }).caps.itemCostUsd, 0.015);
  for (const v of [0, -1, 1e309]) assert.throws(() => parseConfig({ caps: { itemCostUsd: v } }), /caps\.itemCostUsd/);
});

test('committed .factory/config.json equals DEFAULT_CONFIG', () => {
  const path = join(import.meta.dirname, '../../../.factory/config.json');
  assert.deepEqual(loadConfig(path), DEFAULT_CONFIG);
});
