import getPort from "get-port";

/**
 * Free-port allocation via get-port, which keeps an in-process registry of
 * recently returned ports so concurrent allocations (parallel environments,
 * etcd + apiserver starting together) can't collide — the same defence as
 * upstream envtest's addr.Suggest cache. The listen/close/reuse race against
 * *other* processes remains, as it does upstream.
 */
export function getFreePort(host = "127.0.0.1"): Promise<number> {
  return getPort({ host });
}

/**
 * Go's net error text for a lost bind race: "address already in use" on
 * POSIX, "Only one usage of each socket address..." on Windows. etcd and
 * kube-apiserver print these verbatim, and ManagedProcess start errors
 * embed the captured output, so matching the message is sufficient.
 */
const BIND_FAILURE = /address already in use|only one usage of each socket address/i;

export function isBindFailure(err: unknown): boolean {
  return err instanceof Error && BIND_FAILURE.test(err.message);
}

/**
 * Runs fn, retrying when it fails because another process grabbed the
 * suggested port between allocation and bind — fn must re-allocate its
 * port(s) on each call. Cheap insurance for the cross-process race that
 * get-port's in-process registry cannot cover (upstream lives with it).
 * Any other failure propagates immediately.
 */
export async function retryOnBindFailure(fn: () => Promise<void>, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isBindFailure(err)) throw err;
    }
  }
}

/** host:port for use in URLs, bracketing IPv6 literals. */
export function hostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * The host clients should dial to reach a server bound to listenAddress:
 * wildcard binds serve loopback (among everything else), anything specific
 * is dialed directly.
 */
export function connectHostFor(listenAddress: string): string {
  if (listenAddress === "0.0.0.0") return "127.0.0.1";
  if (listenAddress === "::") return "::1";
  return listenAddress;
}
