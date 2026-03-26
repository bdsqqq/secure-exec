'use strict';

const assert = require('assert');
const crypto = require('crypto');

// Crypto helper shim for vendored Node.js conformance tests.
// Keep these helpers close to the upstream common/crypto.js surface used by
// the imported tests so keygen/sign/encrypt assertions can run unchanged.

const opensslVersion = String(process.versions?.openssl || '');
const opensslParts = opensslVersion
  .replace(/[^0-9.].*$/, '')
  .split('.')
  .map((part) => Number(part) || 0);

function hasOpenSSL(major, minor = 0, patch = 0) {
  const [currentMajor, currentMinor, currentPatch] = opensslParts;
  if (currentMajor > major) return true;
  if (currentMajor < major) return false;
  if (currentMinor > minor) return true;
  if (currentMinor < minor) return false;
  return currentPatch >= patch;
}

const hasOpenSSL3 = hasOpenSSL(3, 0, 0);

const pkcs1PubExp = /-----BEGIN RSA PUBLIC KEY-----/;
const pkcs1PrivExp = /-----BEGIN RSA PRIVATE KEY-----/;
const pkcs8Exp = /-----BEGIN PRIVATE KEY-----/;
const spkiExp = /-----BEGIN PUBLIC KEY-----/;
const sec1Exp = /-----BEGIN EC PRIVATE KEY-----/;
const pkcs8EncExp = /-----BEGIN ENCRYPTED PRIVATE KEY-----/;
function sec1EncExp(cipher) {
  const suffix = cipher ? `[\\s\\S]*${cipher}` : '';
  return new RegExp(`-----BEGIN EC PRIVATE KEY-----${suffix}`, 'i');
}

function pkcs1EncExp(cipher) {
  const suffix = cipher ? `[\\s\\S]*${cipher}` : '';
  return new RegExp(`-----BEGIN RSA PRIVATE KEY-----${suffix}`, 'i');
}

function getValueSize(value) {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  return String(value).length;
}

function assertApproximateSize(value, expected) {
  const actual = getValueSize(value);
  const tolerance = Math.max(32, Math.ceil(expected * 0.35));
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected size near ${expected}, got ${actual}`
  );
}

function testEncryptDecrypt(publicKey, privateKey) {
  const plaintext = Buffer.from('secure-exec');
  const encrypted = crypto.publicEncrypt(publicKey, plaintext);
  const decrypted = crypto.privateDecrypt(privateKey, encrypted);
  assert.ok(plaintext.equals(decrypted));
}

function testSignVerify(publicKey, privateKey) {
  const plaintext = Buffer.from('secure-exec');
  const signature = crypto.sign('sha256', plaintext, privateKey);
  assert.strictEqual(crypto.verify('sha256', plaintext, publicKey, signature), true);
}

module.exports = {
  assertApproximateSize,
  hasOpenSSL,
  hasOpenSSL3,
  pkcs1EncExp,
  pkcs1PrivExp,
  pkcs1PubExp,
  pkcs8Exp,
  pkcs8EncExp,
  sec1EncExp,
  sec1Exp,
  spkiExp,
  testEncryptDecrypt,
  testSignVerify,
};
