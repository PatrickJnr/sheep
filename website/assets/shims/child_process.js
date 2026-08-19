/**
 * Browser shim for `node:child_process`.
 *
 * `spawnSync` returns an error result rather than throwing, which is exactly
 * the shape `shepherd.run` already handles: so a playground program that
 * tries to run a subprocess gets a clear Baa error instead of a crash.
 */

export function spawnSync(program) {
  return {
    status: null,
    stdout: "",
    stderr: "",
    error: new Error(
      `cannot run \`${program}\`: the playground has no operating system to run it on. Install Baa to use \`shepherd.run\`.`,
    ),
  };
}

export default { spawnSync };
