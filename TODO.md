# TODO

- [ ] npm publish workflow (tag-triggered, `npm pack` sanity check of the file list) — deliberately deferred.

## Upstream parity gaps (from auditing upstream's test suites)

Features upstream envtest implements and tests that envtest-js doesn't have yet:

- [ ] `CRDInstallOptions` parity: accept in-memory CRD objects alongside paths; `errorIfPathMissing` toggle — NOTE upstream's default is to *silently skip* missing paths ("should not return an error if the directory doesn't exist") while we always throw, a deliberate-for-now deviation; configurable poll interval / max wait.
- [ ] `AddUser` (plane.AddUser / auth.go CertAuthn): provision additional users with their own client certs, REST config, and kubectl-ready kubeconfig — e.g. for testing RBAC as a non-admin identity.
- [ ] `UseExistingCluster`: attach to a pre-existing cluster via kubeconfig instead of spawning a control plane (envtest_test.go Stop cleanup test exercises it).
- [ ] Cache management à la `setup-envtest list`/`cleanup` (store_test.go): enumerate and remove cached binary versions.
- [ ] Minor parity, batched: configurable readiness poll interval (process_test.go tests both default and configured intervals; ours is fixed 150ms); process-group kill on stop (process_test.go "stops the full process group including all its children" — moot for etcd/kube-apiserver, which don't fork); tinyca resolves DNS serving-cert names and adds their IPs as IP SANs (tinyca_test.go) — ours only adds names as given.

## Later / nice-to-have

- [ ] Bun upstream bug to report/track: Bun caches the first mTLS trust context process-wide (node:https, node:http, native fetch; per-request ca/cert/key ignored afterwards; only raw tls.connect honors options — verified experimentally). Consequence: a second TestEnvironment (distinct throwaway CA) in one Bun process cannot be reached. Revisit multi-env Bun support when fixed; a workaround would require hand-rolled HTTP over tls.connect, deliberately rejected.
- [ ] Bun upstream bug to report/track: under Bun, node-tar's `tar.x` silently drops extracted files smaller than ~512KB (bisected: 256KB dropped, 512KB extracted; both .tar and .tar.gz). Harmless for real envtest archives (binaries are 30MB+) but bit our download tests, whose fixture binaries are now padded past the threshold.
- [ ] Decide on `advertise-address`: we pin `127.0.0.1` (kubernetes.default endpoints point at loopback); modern upstream doesn't set it (apiserver autodetects the primary interface IP). Keep our pin (more hermetic) or drop the line for strict upstream parity.
- [ ] Retry-on-bind-failure for the cross-process port race (cheap insurance; upstream lives with it). The in-process race is already covered: get-port tracks recently returned ports, like upstream's addr.Suggest cache.
- [ ] PID-file sweep to reap orphaned etcd/kube-apiserver from crashed runs.
