# Changelog

## [1.9.0](https://github.com/gabelul/bpx-council/compare/v1.8.0...v1.9.0) (2026-08-09)


### Features

* add --isolate to ignore the project's agent instructions ([d49c2ce](https://github.com/gabelul/bpx-council/commit/d49c2ce8e77ed04853eb6e1c7b2c60d2c54ee030))


### Bug Fixes

* stop writing config keys nothing reads, and refuse amp up front ([e574b80](https://github.com/gabelul/bpx-council/commit/e574b80bd35554ddd7a64e2313040e5b6c26ce7d))

## [1.8.0](https://github.com/gabelul/bpx-council/compare/v1.7.0...v1.8.0) (2026-08-03)


### Features

* attach files and images to a consult ([e41dc8c](https://github.com/gabelul/bpx-council/commit/e41dc8cb7ae8855e93896fc173bf9030a06d75b0))

## [1.7.0](https://github.com/gabelul/bpx-council/compare/v1.6.1...v1.7.0) (2026-08-03)


### Features

* set reasoning effort per backend with [@level](https://github.com/level) specs ([40a7b65](https://github.com/gabelul/bpx-council/commit/40a7b658be6e3ea17f332d46b72649c43d35960f))

## [1.6.1](https://github.com/gabelul/bpx-council/compare/v1.6.0...v1.6.1) (2026-08-03)


### Styles

* draw the config wizard on a rail and colour it by meaning ([d95e285](https://github.com/gabelul/bpx-council/commit/d95e285b4002faa12f819f0be0b1ff3fa6285d8c))

## [1.6.0](https://github.com/gabelul/bpx-council/compare/v1.5.0...v1.6.0) (2026-07-31)


### Features

* add a config wizard and a one-command setup ([3587596](https://github.com/gabelul/bpx-council/commit/3587596bf4dd98d06555b99ee6aef89f8c154f9b))
* add cursor, gemini, qwen, crush and amp as advisor backends ([38a76c6](https://github.com/gabelul/bpx-council/commit/38a76c6a02a2a7f5012c99c4c5d7423a92e0ec2c))
* arrow-key pickers and a type-to-filter model picker ([7b2006b](https://github.com/gabelul/bpx-council/commit/7b2006b9daa079e3b44ab1a114306443327e0581))
* layer a per-project .bpx-council.json over the global config ([de9f057](https://github.com/gabelul/bpx-council/commit/de9f057f906ebaa1201ab49839d3579ab5ec0c9a))
* pin a model per backend with backend:model specs ([0ec7424](https://github.com/gabelul/bpx-council/commit/0ec742481f23e55f3d34b5598f98fadfd9a54420))

## [1.5.0](https://github.com/gabelul/bpx-council/compare/v1.4.0...v1.5.0) (2026-07-22)


### Features

* colored, organized install output with a star nudge ([#10](https://github.com/gabelul/bpx-council/issues/10)) ([f63c6c4](https://github.com/gabelul/bpx-council/commit/f63c6c4fc12211d7077fe462b00b7dadc8188121))

## [1.4.0](https://github.com/gabelul/bpx-council/compare/v1.3.0...v1.4.0) (2026-07-22)


### Features

* checkbox multi-select in install wizard (+ postinstall hint fix) ([#8](https://github.com/gabelul/bpx-council/issues/8)) ([14c347e](https://github.com/gabelul/bpx-council/commit/14c347ed5b605864b4af76eba973a4979a402763))

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
