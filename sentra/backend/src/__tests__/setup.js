// Loaded before any test module.

// Marks the process as a test run so config/env.ts skips loading the
// developer's .env, and metrics.store skips reading and writing their .data —
// without this, local state leaks into assertions and the suite passes on one
// machine and fails on another.
process.env.NODE_ENV = "test";

// Silence application logging to stdout for the duration of the run.
//
// Not cosmetic. `node --test` runs each file in a child process that reports
// its results as v8-serialised frames written to STDOUT. Anything else written
// there lands between frames and corrupts the stream, and the parent fails the
// whole file with "Unable to deserialize cloned data due to invalid or
// unsupported version" — an error about a broken test that is really an
// application banner arriving at the wrong moment.
//
// It is timing-dependent, so it showed up as CI failing intermittently on the
// two suites that boot a real server and mutate the wallet registry, on
// commits that touched neither.
//
// console.warn and console.error are deliberately left alone: they write to
// stderr, which carries no frames, and they are what makes a failure
// diagnosable.
for (const method of ["log", "info", "debug"]) {
  console[method] = () => {};
}
