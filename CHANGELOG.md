# Changelog

## [1.3.0](https://github.com/gabelul/bpx-council/compare/v1.2.0...v1.3.0) (2026-07-22)


### Features

* version flag, update notice, and onboarding nudges ([#6](https://github.com/gabelul/bpx-council/issues/6)) ([76073e4](https://github.com/gabelul/bpx-council/commit/76073e4664c9e23b7b0073819465f74ba09ea9e3))

## [1.2.0](https://github.com/gabelul/bpx-council/compare/v1.1.0...v1.2.0) (2026-07-22)


### Features

* add install wizard for coding agents with link mode ([#4](https://github.com/gabelul/bpx-council/issues/4)) ([b8c94ce](https://github.com/gabelul/bpx-council/commit/b8c94cec184eadf2bf5168d1c391af58fca09394))

## [1.1.0](https://github.com/gabelul/bpx-council/compare/v1.0.0...v1.1.0) (2026-07-21)


### Features

* make council genuinely multi-model via per-persona backends ([#3](https://github.com/gabelul/bpx-council/issues/3)) ([498ac4f](https://github.com/gabelul/bpx-council/commit/498ac4f9ee3bb0844ab9a2d56e71fef6ba48c44e))


### Bug Fixes

* **ci:** Node 24 + remove empty NODE_AUTH_TOKEN for OIDC publishing ([c7ecbc0](https://github.com/gabelul/bpx-council/commit/c7ecbc097b58779ae0c1593a2fe4fb1f5a92cffb))
* five bugs from battle testing — model flag, debate output, partial failure, progress, rounds ([74f07cc](https://github.com/gabelul/bpx-council/commit/74f07cc8c5b53fa65ac6648f4d40657c6b6a5c1d))

## 1.0.0 (2026-07-19)


### Features

* all four modes + tests — solo, council, debate, gut-check ([81bfd5f](https://github.com/gabelul/bpx-council/commit/81bfd5f452cb46182097aca53904b343d2949a96))
* auto-detection + Anthropic HTTP backend — works from any host ([9b3cd1e](https://github.com/gabelul/bpx-council/commit/9b3cd1e0487434ac72275716d51d6f0dea6a5e32))
* full bpx-council CLI — four modes, PTY/CLI/HTTP backends, auto-detection ([e72ff39](https://github.com/gabelul/bpx-council/commit/e72ff39bb24da4b944edd3833536781a3d0c8980))
* PTY backend rewritten with proven tmux patterns ([7fa3a54](https://github.com/gabelul/bpx-council/commit/7fa3a546f05297c6759e6f4a4b1a70af257f6a77))
* PTY/tmux backend — subscription-preserving advisor calls ([7ef51fd](https://github.com/gabelul/bpx-council/commit/7ef51fd507a5d04be408c7a8b49b4f1324633bca))
* scaffold bpx-council — portable multi-model council CLI ([ccc72c9](https://github.com/gabelul/bpx-council/commit/ccc72c9392112e38b78340805ea2edcbcefcf776))


### Bug Fixes

* sentinel-based response extraction — clean output, zero noise ([8c15af6](https://github.com/gabelul/bpx-council/commit/8c15af6969d4b67d84f5b0a60de95532de6d7d5e))
