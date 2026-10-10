import { describe, expect, test } from "bun:test";
import { getAccessibilitySnapshot } from "../src/accessibility.ts";
import type { ExecOpts, ExecResult, execText } from "../src/exec.ts";

type ExecCall = { args: string[]; opts: ExecOpts };

const XML =
  '<hierarchy><node text="OK" resource-id="" class="android.widget.Button" ' +
  'package="com.example" content-desc="" clickable="true" enabled="true" ' +
  'bounds="[0,0][100,50]" /></hierarchy>';

function result(overrides: Partial<ExecResult<string>> = {}): ExecResult<string> {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    error: null,
    ...overrides,
  };
}

type Step = "dump" | "cat" | "rm";

/** A fake adb whose response to each step is scripted by the test. */
function fakeAdb(
  respond: (step: Step, call: ExecCall) => ExecResult<string> | Promise<ExecResult<string>>,
) {
  const calls: ExecCall[] = [];
  const run = (async (_cmd: string, args: string[], opts: ExecOpts = {}) => {
    const call = { args, opts };
    calls.push(call);
    const step: Step = args.includes("dump") ? "dump" : args.includes("cat") ? "cat" : "rm";
    return respond(step, call);
  }) as typeof execText;
  const steps = () =>
    calls.map((call) => {
      const shell = call.args.slice(call.args.indexOf("shell") + 1);
      return shell.join(" ");
    });
  return { calls, run, steps };
}

const noSleep = async () => {};

describe("accessibility dumps", () => {
  test("dumps, reads, and removes the file before returning nodes", async () => {
    const adb = fakeAdb((step) => result({ stdout: step === "cat" ? XML : "" }));
    const snapshot = await getAccessibilitySnapshot("device-a", undefined, {
      execText: adb.run,
      sleep: noSleep,
    });
    expect(snapshot.nodes).toHaveLength(1);
    const [dump, cat, rm] = adb.steps();
    const path = dump!.split(" ").at(-1)!;
    expect(path).toMatch(/^\/sdcard\/window-\d+-1\.xml$/);
    expect(adb.steps()).toEqual([`uiautomator dump ${path}`, `cat ${path}`, `rm -f ${path}`]);
    expect(cat).toBe(`cat ${path}`);
    expect(rm).toBe(`rm -f ${path}`);
    // Cleanup runs on the interactive lane (never queue-full) without the
    // session signal, so an abort cannot skip it.
    expect(adb.calls[2]!.opts).toMatchObject({ lane: "interactive", timeout: 2_000 });
    expect(adb.calls[2]!.opts.signal).toBeUndefined();
  });

  test.each(["during the dump", "after a successful dump", "during cat"] as const)(
    "an abort %s removes the file exactly once and rejects with the reason",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error(`session ended ${stage}`);
      const adb = fakeAdb((step) => {
        if (step === "dump") {
          controller.abort(reason);
          return result(stage === "during the dump" ? { status: null, signal: "SIGTERM", error: reason } : {});
        }
        if (step === "cat") {
          controller.abort(reason);
          return result({ status: null, signal: "SIGTERM", error: reason });
        }
        return result();
      });
      const loading = getAccessibilitySnapshot("device-a", controller.signal, {
        execText: adb.run,
        sleep: noSleep,
      });
      await expect(loading).rejects.toBe(reason);
      const steps = adb.steps();
      const path = steps[0]!.split(" ").at(-1)!;
      expect(steps.filter((step) => step.startsWith("rm"))).toEqual([`rm -f ${path}`]);
      expect(steps.at(-1)).toBe(`rm -f ${path}`);
      expect(steps.filter((step) => step.startsWith("uiautomator"))).toHaveLength(1);
    },
  );

  test("retries a failed dump at a new path and cleans up every attempt", async () => {
    let dumps = 0;
    const sleeps: number[] = [];
    const adb = fakeAdb((step) => {
      if (step === "dump") {
        dumps++;
        return dumps < 3 ? result({ status: 1, stderr: "ERROR: could not get idle state" }) : result();
      }
      return result({ stdout: step === "cat" ? XML : "" });
    });
    const snapshot = await getAccessibilitySnapshot("device-a", undefined, {
      execText: adb.run,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(snapshot.nodes).toHaveLength(1);
    const paths = adb.steps().filter((s) => s.startsWith("uiautomator")).map((s) => s.split(" ").at(-1));
    expect(new Set(paths).size).toBe(3);
    expect(adb.steps().filter((s) => s.startsWith("rm"))).toEqual(paths.map((p) => `rm -f ${p}`));
    expect(sleeps).toEqual([150, 300]);
  });

  test("retries when reading the dump fails", async () => {
    let cats = 0;
    const adb = fakeAdb((step) => {
      if (step !== "cat") return result();
      cats++;
      return cats === 1
        ? result({ status: 1, stderr: "cat: No such file or directory" })
        : result({ stdout: XML });
    });
    const snapshot = await getAccessibilitySnapshot("device-a", undefined, {
      execText: adb.run,
      sleep: noSleep,
    });
    expect(snapshot.nodes).toHaveLength(1);
    expect(adb.steps().filter((s) => s.startsWith("rm"))).toHaveLength(2);
  });

  test("does not sleep after the final failed attempt", async () => {
    const sleeps: number[] = [];
    const adb = fakeAdb((step) =>
      step === "dump" ? result({ status: 1, stderr: "ERROR: null root node" }) : result(),
    );
    await expect(
      getAccessibilitySnapshot("device-a", undefined, {
        execText: adb.run,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow("ERROR: null root node");
    expect(sleeps).toEqual([150, 300]);
    expect(adb.steps().filter((s) => s.startsWith("uiautomator"))).toHaveLength(3);
    expect(adb.steps().filter((s) => s.startsWith("rm"))).toHaveLength(3);
  });

  test("an abort during a retry sleep rejects at once and starts no further dump", async () => {
    const controller = new AbortController();
    const reason = new Error("device switched");
    const adb = fakeAdb((step) =>
      step === "dump" ? result({ status: 1, stderr: "ERROR: could not get idle state" }) : result(),
    );
    const loading = getAccessibilitySnapshot("device-a", controller.signal, { execText: adb.run });
    // The default sleep is abortable: abort while it waits 150 ms.
    await Bun.sleep(20);
    const abortedAt = performance.now();
    controller.abort(reason);
    await expect(loading).rejects.toBe(reason);
    expect(performance.now() - abortedAt).toBeLessThan(100);
    expect(adb.steps().filter((s) => s.startsWith("uiautomator"))).toHaveLength(1);
  });

  test("a failed cleanup does not hide the dump result", async () => {
    const adb = fakeAdb((step) =>
      step === "rm" ? Promise.reject(new Error("queue-full")) : result({ stdout: step === "cat" ? XML : "" }),
    );
    const snapshot = await getAccessibilitySnapshot("device-a", undefined, {
      execText: adb.run,
      sleep: noSleep,
    });
    expect(snapshot.nodes).toHaveLength(1);
  });

  test("rejects before any adb call when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    const adb = fakeAdb(() => result());
    await expect(
      getAccessibilitySnapshot("device-a", controller.signal, { execText: adb.run }),
    ).rejects.toThrow("gone");
    expect(adb.calls).toHaveLength(0);
  });
});
