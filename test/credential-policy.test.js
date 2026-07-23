'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldValidateCredentialUpdate, validateCredentialUpdate } = require('../src/core/credential-policy');

const passwordServer = { authMode: 'password' };
const keyServer = { authMode: 'key' };

test('a changed password-server signature requires a new password', () => {
  assert.match(validateCredentialUpdate({
    server: passwordServer,
    existed: true,
    signatureChanged: true,
    metadata: { hasPassword: true },
    update: {},
  }), /again/);
  assert.equal(validateCredentialUpdate({
    server: passwordServer,
    existed: true,
    signatureChanged: true,
    metadata: { hasPassword: true },
    update: { password: 'fresh' },
  }), null);
});

test('a new password server and a password-removal request cannot save empty credentials', () => {
  assert.match(validateCredentialUpdate({ server: passwordServer }), /Enter/);
  assert.match(validateCredentialUpdate({
    server: passwordServer,
    existed: true,
    metadata: { hasPassword: true },
    update: { clearPassword: true },
  }), /Enter/);
});

test('a changed key-server signature requires passphrase replacement or explicit removal', () => {
  const base = {
    server: keyServer,
    existed: true,
    signatureChanged: true,
    metadata: { hasPassphrase: true },
  };
  assert.match(validateCredentialUpdate(base), /remove/);
  assert.equal(validateCredentialUpdate({ ...base, update: { passphrase: 'fresh' } }), null);
  assert.equal(validateCredentialUpdate({ ...base, update: { clearPassphrase: true } }), null);
});

test('a contradictory request to enter and remove a secret is rejected', () => {
  assert.match(validateCredentialUpdate({
    server: keyServer,
    update: { passphrase: 'fresh', clearPassphrase: true },
  }), /same time/);
});

test('an existing server with untouched credentials does not block unrelated saves', () => {
  assert.equal(shouldValidateCredentialUpdate({
    existed: true,
    signatureChanged: false,
    hasSecretUpdate: false,
  }), false);
  assert.equal(shouldValidateCredentialUpdate({
    existed: true,
    signatureChanged: false,
    hasSecretUpdate: true,
  }), true);
  assert.equal(shouldValidateCredentialUpdate({
    existed: true,
    signatureChanged: true,
    hasSecretUpdate: false,
  }), true);
});
