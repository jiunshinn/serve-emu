import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBar } from "../src/ui/components/status-bar";
import { parseStreamHealth } from "../src/ui/lib/stream-state";

const size = { width: 576, height: 1280 };

describe("device contention in the UI (#76)", () => {
  test("reads contention leniently from /health", () => {
    expect(parseStreamHealth({ size, contention: { otherScrcpySessions: 2, checkedAt: "x" } }))
      .toMatchObject({ otherScrcpySessions: 2 });
    expect(parseStreamHealth({ size, contention: null })).not.toHaveProperty("otherScrcpySessions");
    // A malformed diagnostic must not fail the poll.
    expect(parseStreamHealth({ size, contention: { otherScrcpySessions: -1 } })).not.toHaveProperty("otherScrcpySessions");
    expect(parseStreamHealth({ size, contention: "busy" })).not.toHaveProperty("otherScrcpySessions");
  });

  test("warns in the status bar while other sessions stream the device", () => {
    const render = (otherScrcpySessions: number) =>
      renderToStaticMarkup(
        <StatusBar status="streaming" deviceSize={size} fps={60} otherScrcpySessions={otherScrcpySessions} />,
      );
    expect(render(0)).not.toContain('role="status"');
    expect(render(1)).toContain(">Another scrcpy session is streaming this device</span>");
    expect(render(3)).toContain(">3 other scrcpy sessions are streaming this device</span>");
  });
});
