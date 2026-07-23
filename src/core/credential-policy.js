'use strict';

function hasValue(value) {
  return typeof value === 'string' && value.length > 0;
}

function shouldValidateCredentialUpdate({ existed, signatureChanged, hasSecretUpdate }) {
  return !existed || signatureChanged || hasSecretUpdate;
}

function validateCredentialUpdate({
  server,
  existed = false,
  signatureChanged = false,
  metadata = {},
  update = {},
}) {
  const changes = update && typeof update === 'object' ? update : {};
  if (changes.clearPassword && hasValue(changes.password)) {
    return 'An SSH password cannot be entered and removed at the same time.';
  }
  if (changes.clearPassphrase && hasValue(changes.passphrase)) {
    return 'A key passphrase cannot be entered and removed at the same time.';
  }

  if (server.authMode === 'password') {
    const freshPassword = hasValue(changes.password);
    const canRetainPassword = existed
      && !signatureChanged
      && metadata.hasPassword
      && !changes.clearPassword;
    if (!freshPassword && !canRetainPassword) {
      return signatureChanged
        ? 'The server address or authentication details changed. Enter the SSH password again.'
        : 'Enter the SSH password.';
    }
  }

  if (
    server.authMode === 'key'
    && existed
    && signatureChanged
    && metadata.hasPassphrase
    && !hasValue(changes.passphrase)
    && changes.clearPassphrase !== true
  ) {
    return 'The server or private key changed. Enter the passphrase again or choose to remove the saved passphrase.';
  }

  return null;
}

module.exports = { shouldValidateCredentialUpdate, validateCredentialUpdate };
