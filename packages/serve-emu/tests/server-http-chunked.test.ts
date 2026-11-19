import { createConnection } from "node:net";
import { expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import { fakeScrcpy } from "./helpers/server-harness.ts";

function rawChunkedRequest(port: number, body: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      fail(new Error("Timed out waiting for the chunked HTTP response"));
    }, 5_000);
    socket.setNoDelay(true);
    socket.on("connect", () => {
      socket.write(
        "POST /api/tap HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Content-Type: application/json\r\n" +
          "Transfer-Encoding: chunked\r\n" +
          "Connection: close\r\n\r\n",
      );
      for (let offset = 0; offset < body.length; offset += 97) {
        const chunk = body.slice(offset, offset + 97);
        socket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n`);
        socket.write(chunk);
        socket.write("\r\n");
      }
      // Keep the writable side open so Bun can finish parsing the terminal
      // chunk and send its response before the client half-closes the socket.
      socket.write("0\r\n\r\n");
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", fail);
  });
}

test("real Bun HTTP rejects oversized chunked JSON with structured 413", async () => {
  const session = fakeScrcpy("device-test");
  // A real listening server: the test sends raw chunked HTTP over a socket.
  const started = await startServer(
    { serial: session.serial, port: 0 },
    {
      log: () => {},
      openScrcpy: async () => session,
      listDevices: async () => [
        { serial: session.serial, state: "device" },
      ],
    },
  );
  try {
    const body = JSON.stringify({ x: 0.5, padding: "x".repeat(9_000) });
    const response = await rawChunkedRequest(started.server.port!, body);

    expect(response).toContain(" 413 ");
    expect(response).toContain('"code":"payload_too_large"');
  } finally {
    await started.stop();
  }
});
