/**
 * Browser shim for `node:crypto`.
 *
 * Backed by the Web Crypto API, so randomness in the playground is as strong
 * as it is on the desktop.
 */

export function randomBytes(count) {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function createHash() {
  throw new Error(
    "Hashing is not available in the playground. It is only used by `baa build`, which needs a filesystem.",
  );
}

export default { randomBytes, createHash };
