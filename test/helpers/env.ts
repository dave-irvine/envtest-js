/**
 * Run fn with process.env temporarily overridden (a value of undefined
 * deletes the variable), restoring every touched variable afterwards even
 * when fn throws. Plain process.env mutation because this must work under
 * both vitest and bun:test — vi.stubEnv is vitest-only.
 */
export async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map(Object.keys(vars).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
