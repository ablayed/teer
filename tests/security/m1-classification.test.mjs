import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAuthorization } from './m1-result-classification.mjs';

test('503 without disclosure is indeterminate, never an authorization denial', () => {
  assert.equal(
    classifyAuthorization({ expected: false, observed: false, status: 503, contractDenied: true }),
    'INDETERMINATE_PROCESSING_ERROR',
  );
});
test('positive access must actually succeed', () => {
  assert.equal(
    classifyAuthorization({ expected: true, observed: true, status: 200 }),
    'AUTHORIZATION_CONFIRMED',
  );
  assert.equal(
    classifyAuthorization({ expected: true, observed: false, status: 503 }),
    'INDETERMINATE_PROCESSING_ERROR',
  );
});
test('a negative case needs evidence of the denial contract', () => {
  assert.equal(
    classifyAuthorization({ expected: false, observed: false, status: 403, contractDenied: true }),
    'DENIAL_CONFIRMED',
  );
  assert.equal(
    classifyAuthorization({ expected: false, observed: false, status: 200 }),
    'INDETERMINATE_CONTRACT_EVIDENCE',
  );
});
test('forbidden data observed remains a violation even on an error response', () => {
  assert.equal(
    classifyAuthorization({ expected: false, observed: true, status: 503 }),
    'VIOLATION_CONFIRMED',
  );
});
