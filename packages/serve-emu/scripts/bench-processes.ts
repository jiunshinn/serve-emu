import { execFileSync } from "node:child_process";

export function readMacProcesses(output = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8" })) {
  const processes = new Map<number, { ppid: number; cpuTicks: number; rssMb: number; command: string }>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:-\d+)?:\d+(?::\d+)?(?:\.\d+)?)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, rss, elapsed, command] = match;
    const time = elapsed!.split("-");
    const seconds = time.pop()!.split(":").reverse().reduce((total, part, index) => total + Number(part) * 60 ** index, 0);
    processes.set(Number(pid), {
      ppid: Number(ppid),
      cpuTicks: Math.round((seconds + Number(time.pop() ?? 0) * 86400) * 100),
      rssMb: Number(rss) / 1024,
      command: command!,
    });
  }
  return processes;
}
