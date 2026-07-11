# TODO

## Upstream parity gaps (from auditing upstream's test suites)

Features upstream envtest implements and tests that envtest-js doesn't have yet:

- [ ] `UseExistingCluster`: attach to a pre-existing cluster via kubeconfig instead of spawning a control plane (envtest_test.go Stop cleanup test exercises it).

## Later / nice-to-have

- [ ] Process-group kill on stop (process_test.go "stops the full process group including all its children") — moot for etcd/kube-apiserver, which don't fork; revisit only if we ever manage a forking child process.
- [ ] Bun upstream bug to report/track: Bun caches the first mTLS trust context process-wide (node:https, node:http, native fetch; per-request ca/cert/key ignored afterwards; only raw tls.connect honors options — verified experimentally). Consequence: a second TestEnvironment (distinct throwaway CA) in one Bun process cannot be reached. Revisit multi-env Bun support when fixed; a workaround would require hand-rolled HTTP over tls.connect, deliberately rejected.
- [ ] Bun upstream bug to report/track: under Bun, node-tar's `tar.x` silently drops extracted files smaller than ~512KB (bisected: 256KB dropped, 512KB extracted; both .tar and .tar.gz). Harmless for real envtest archives (binaries are 30MB+) but bit our download tests, whose fixture binaries are now padded past the threshold.
- [ ] Decide on `advertise-address`: we pin `127.0.0.1` (kubernetes.default endpoints point at loopback); modern upstream doesn't set it (apiserver autodetects the primary interface IP). Keep our pin (more hermetic) or drop the line for strict upstream parity.
- [ ] PID-file sweep to reap orphaned etcd/kube-apiserver from crashed runs.
