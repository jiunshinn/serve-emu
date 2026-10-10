// Floors apply to executed lines, not merely LCOV file presence. Browser-only
// Worker/React code has no line floors here; the browser CI job runs it
// (tests/browser): a real H.264 GOP with delta frames, cached SPS/PPS for a
// late joiner, reset-video recovery, scrcpy v4 framing, and the token cookie.
const CRITICAL_SOURCE_FILES = {
  "src/server.ts": 80,
  "src/api/router.ts": 85,
  "src/api/routes/index.ts": 100,
  "src/api/routes/applications.ts": 95,
  "src/api/routes/devices.ts": 80,
  "src/api/routes/inspection.ts": 80,
  "src/api/routes/session.ts": 75,
  "src/device-service.ts": 95,
  "src/server/auth.ts": 95,
  "src/server/backpressure.ts": 95,
  "src/request-body.ts": 95,
  "src/server/health.ts": 95,
  "src/server/static.ts": 95,
  "src/server/ws.ts": 90,
  "src/control-input-queue.ts": 90,
  "src/device-session-context.ts": 85,
  "src/scrcpy.ts": 85,
  "src/adb-command.ts": 95,
  "src/input.ts": 90,
  "src/route-playback.ts": 90,
  "src/session-recorder.ts": 95,
  "src/ui/lib/stream-lifecycle.ts": 95,
  "src/ui/lib/stream-performance.ts": 95,
  "src/ui/lib/device-session-store.ts": 80,
} as const;

const lcovFile = Bun.file(new URL("../coverage/lcov.info", import.meta.url));
if (!(await lcovFile.exists())) {
  console.error("coverage/lcov.info was not generated");
  process.exit(1);
}

const records = (await lcovFile.text())
  .split("end_of_record")
  .map((record) => {
    const source = record.match(/^SF:(.+)$/m)?.[1]?.replaceAll("\\", "/");
    const linesFound = Number(record.match(/^LF:(\d+)$/m)?.[1] ?? "0");
    const linesHit = Number(record.match(/^LH:(\d+)$/m)?.[1] ?? "0");
    return { source, linesFound, linesHit };
  })
  .filter((record) => record.source);

const failures = Object.entries(CRITICAL_SOURCE_FILES).flatMap(
  ([required, floor]) => {
    const record = records.find((record) => record.source?.endsWith(required));
    if (!record || record.linesFound === 0)
      return [`${required}: missing coverage`];
    const percent = (record.linesHit / record.linesFound) * 100;
    return percent + 0.001 < floor
      ? [`${required}: ${percent.toFixed(2)}% < ${floor}%`]
      : [];
  },
);
if (failures.length) {
  console.error(`Critical line coverage failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  `Executed line coverage meets all ${Object.keys(CRITICAL_SOURCE_FILES).length} critical module floors`,
);
