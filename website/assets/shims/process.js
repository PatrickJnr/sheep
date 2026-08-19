/**
 * Browser shim for `node:process`.
 *
 * Enough of the surface for the interpreter and the `shepherd` module to load
 * and behave sensibly. Writes go nowhere by default; the playground replaces
 * the host's streams anyway, so program output is captured properly.
 */

const noop = () => true;

export const platform = "browser";
export const arch = "wasm32";
export const env = {};
export const argv = ["baa", "playground"];
export const versions = { node: "playground" };
export const version = "playground";

export const stdout = { write: noop, isTTY: false };
export const stderr = { write: noop, isTTY: false };
export const stdin = { isTTY: false };

export function cwd() {
  return "/baa";
}

export function exit() {
  return undefined;
}

export function on() {
  return undefined;
}

export default {
  platform,
  arch,
  env,
  argv,
  versions,
  version,
  stdout,
  stderr,
  stdin,
  cwd,
  exit,
  on,
  exitCode: 0,
};
