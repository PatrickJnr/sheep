/**
 * Browser shim for `node:path`.
 *
 * The playground runs the real Baa interpreter, which imports `node:path` for
 * the `pasture` module's path arithmetic. These are pure string operations, so
 * a POSIX-style implementation is genuinely correct in a browser, there are no
 * drive letters to worry about when there is no filesystem.
 */

export const sep = "/";
export const delimiter = ":";

function split(path) {
  return path.split("/");
}

export function isAbsolute(path) {
  return path.startsWith("/");
}

export function normalize(path) {
  const absolute = isAbsolute(path);
  const trailing = path.endsWith("/") && path.length > 1;
  const parts = [];
  for (const part of split(path)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  let result = parts.join("/");
  if (absolute) result = `/${result}`;
  if (result === "") result = absolute ? "/" : ".";
  if (trailing && !result.endsWith("/")) result += "/";
  return result;
}

export function join(...parts) {
  const joined = parts.filter((part) => part !== "").join("/");
  return joined === "" ? "." : normalize(joined);
}

export function resolve(...parts) {
  let resolved = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part === undefined || part === "") continue;
    resolved = resolved === "" ? part : `${part}/${resolved}`;
    if (isAbsolute(part)) break;
  }
  if (!isAbsolute(resolved)) resolved = `/baa/${resolved}`;
  return normalize(resolved);
}

export function dirname(path) {
  const normalised = normalize(path);
  const index = normalised.lastIndexOf("/");
  if (index === -1) return ".";
  if (index === 0) return "/";
  return normalised.slice(0, index);
}

export function basename(path, suffix) {
  const parts = split(normalize(path)).filter((part) => part !== "");
  const last = parts.length === 0 ? "" : parts[parts.length - 1];
  if (suffix !== undefined && last.endsWith(suffix) && last !== suffix) {
    return last.slice(0, -suffix.length);
  }
  return last;
}

export function extname(path) {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

export function relative(from, to) {
  const fromParts = split(resolve(from)).filter(Boolean);
  const toParts = split(resolve(to)).filter(Boolean);
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) {
    shared++;
  }
  const up = new Array(fromParts.length - shared).fill("..");
  return [...up, ...toParts.slice(shared)].join("/");
}

export default {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
};
