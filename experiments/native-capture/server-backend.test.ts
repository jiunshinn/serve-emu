import { expect, test } from "bun:test";

/** Start the real CLI with every native dependency intentionally unavailable. */
async function withServer(backend: "scrcpy" | "auto", inspect: (origin: string) => Promise<void>) {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const child = Bun.spawn([
    process.execPath, "server.ts", "--backend", backend,
    "--serial", "emulator-5556", "--port", String(port),
    "--emulator-dir", "/missing-sdk-for-backend-test",
    "--discovery", "/missing-discovery-for-backend-test",
  ], {
    cwd: import.meta.dir,
    env: { ...process.env, PATH: "/missing-tools-for-backend-test" },
    stdout: "ignore", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${await stderr}`);
      try { ready = (await fetch(`${origin}/config`)).ok; } catch {}
      if (ready) break;
      await Bun.sleep(25);
    }
    if (!ready) throw new Error("Server did not become ready");
    await inspect(origin);
  } finally {
    child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { await child.exited; await stderr; } finally { clearTimeout(forced); }
  }
}

for (const backend of ["scrcpy", "auto"] as const) {
  test(`real ${backend} CLI serves scrcpy without native tools and blocks native overrides`, async () => {
    await withServer(backend, async (origin) => {
      const config = await (await fetch(`${origin}/config`)).json();
      expect(config.requestedBackend).toBe(backend);
      expect(config.defaultBackend).toBe("scrcpy");
      expect(config.availableBackends).toEqual(["scrcpy"]);
      expect((await fetch(origin)).status).toBe(200);
      const health = await (await fetch(`${origin}/health`)).json();
      expect(health.requestedBackend).toBe(backend);
      expect(health.clients).toBe(0);
      const blocked = await fetch(`${origin}/ws?backend=native`, { headers: { origin } });
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).ok).toBe(false);
      expect((await fetch(`${origin}/config`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    });
  }, 12_000);
}
