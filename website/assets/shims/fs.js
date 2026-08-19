/**
 * Browser shim for `node:fs`.
 *
 * There is no filesystem in a browser tab, and pretending otherwise would be
 * worse than saying so. Each function throws with a message the `pasture`
 * module turns into a normal Baa `BAA404` diagnostic, so a playground program
 * that tries to read a file gets a proper error rather than a stack trace.
 */

function unavailable(operation) {
  return new Error(
    `${operation} is not available in the playground: there is no filesystem in a browser tab. Install Baa to use the \`pasture\` module.`,
  );
}

export function readFileSync(path) {
  throw unavailable(`reading ${path}`);
}

export function writeFileSync(path) {
  throw unavailable(`writing ${path}`);
}

export function existsSync() {
  return false;
}

export function readdirSync(path) {
  throw unavailable(`listing ${path}`);
}

export function mkdirSync() {
  return undefined;
}

export function statSync(path) {
  throw unavailable(`inspecting ${path}`);
}

export function readSync() {
  throw unavailable("reading standard input");
}

/**
 * There are no real paths here, and no links to follow.
 *
 * The capability layer asks for this when it is confining a run to a
 * directory, and treats a failure as "take the path as it was written", which
 * is the only sensible answer in a tab.
 */
export function realpathSync(path) {
  throw unavailable(`resolving ${path}`);
}

realpathSync.native = realpathSync;

export default {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  statSync,
  readSync,
  realpathSync,
};
