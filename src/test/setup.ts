// Preloaded before unit tests (bunfig.toml). config.ts validates the
// environment on import and exits if it's incomplete, which would take down
// any test that touches a module importing it (e.g. via the logger). Unit
// tests never reach Discord or Postgres, so placeholders are enough.
process.env.DISCORD_TOKEN ??= "unit-test-token";
process.env.DISCORD_CLIENT_ID ??= "unit-test-client";
process.env.DATABASE_URL ??= "postgres://unit-test/unused";
process.env.LOG_LEVEL ??= "warn";
