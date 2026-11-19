// One place for the browser fixture's ports and token, shared by
// playwright.config.ts, server-fixture.ts (through the environment), and tests.
export const FIXTURE_PORT = Number(process.env.SERVE_EMU_FIXTURE_PORT ?? 33117);
/** A second fixture server that requires FIXTURE_TOKEN. */
export const TOKEN_FIXTURE_PORT = FIXTURE_PORT + 1;
export const FIXTURE_TOKEN = "fixture-token";
