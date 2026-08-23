// Loaded before any test module. Marks the process as a test run so
// config/env.ts skips loading the developer's .env — without this a local
// Telegram token or RPC URL leaks into assertions and the suite passes on one
// machine and fails on another.
process.env.NODE_ENV = "test";
