/**
 * Side-effect import for interactive-render tests.
 *
 * ink 6 gates ALL frame writes on `is-in-ci`, which reads CI and
 * CONTINUOUS_INTEGRATION at import time. CI runners (GitHub Actions sets
 * CI=true) therefore never paint frames, starving every stdout assertion in
 * files that import this module first — before ink loads.
 */
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
