import { describe, expect, test } from "bun:test";
import { Mp4Frames } from "./mp4-frames.ts";

const sps = Buffer.from([0x67, 0x64, 0, 0x1f]);
const pps = Buffer.from([0x68, 0xee, 0x3c, 0x80]);
const idr = Buffer.from([0x65, 0x88, 0x84]);
const delta = Buffer.from([0x41, 0x9a]);
const start = Buffer.from([0, 0, 0, 1]);

function box(type: string, payload: Buffer, extended = false): Buffer {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(extended ? 1 : header.length + payload.length);
  header.write(type, 4, "ascii");
  if (extended) header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}

function configuration(lengthBytes = 4): Buffer {
  const header = Buffer.from([1, 0x64, 0, 0x1f, 0xfc | (lengthBytes - 1), 0xe1]);
  return Buffer.concat([header, Buffer.from([0, sps.length]), sps, Buffer.from([1, 0, pps.length]), pps]);
}

function movie(config = configuration()): Buffer {
  const entry = box("avc1", Buffer.concat([Buffer.alloc(78), box("avcC", config)]));
  const description = Buffer.alloc(8);
  description.writeUInt32BE(1, 4);
  let content = box("stsd", Buffer.concat([description, entry]));
  for (const type of ["stbl", "minf", "mdia", "trak", "moov"]) content = box(type, content);
  return content;
}

function sample(nals: Buffer[], lengthBytes = 4, extended = false): Buffer {
  return box("mdat", Buffer.concat(nals.flatMap((nal) => {
    const length = Buffer.alloc(lengthBytes);
    length.writeUIntBE(nal.length, 0, lengthBytes);
    return [length, nal];
  })), extended);
}

function recorder() {
  const frames: { data: Buffer; isKey: boolean }[] = [];
  const parser = new Mp4Frames((data, isKey) => frames.push({ data, isKey }));
  return { parser, frames };
}

describe("fragmented MP4 video frames", () => {
  test("emits a complete first frame immediately, including configuration, without a subsequent frame", () => {
    const { parser, frames } = recorder();
    parser.push(movie());
    parser.push(box("moof", Buffer.alloc(0)));
    const packet = sample([idr]);
    parser.push(packet.subarray(0, -1));
    expect(frames).toHaveLength(0);
    parser.push(packet.subarray(-1));
    expect(frames).toEqual([{ data: Buffer.concat([start, sps, start, pps, start, idr]), isKey: true }]);
    parser.finish();
    expect(frames).toHaveLength(1);
  });

  test("survives every byte boundary and emits consecutive key and delta samples", () => {
    const stream = Buffer.concat([
      box("ftyp", Buffer.from("isom")), movie(),
      box("moof", Buffer.alloc(3)), sample([idr]),
      box("free", Buffer.alloc(0)), sample([delta]), sample([idr]),
    ]);
    const expected = [true, false, true];
    for (let split = 1; split < stream.length; split++) {
      const { parser, frames } = recorder();
      parser.push(stream.subarray(0, split));
      parser.push(stream.subarray(split));
      parser.finish();
      expect(frames.map((frame) => frame.isKey)).toEqual(expected);
      expect(frames[1]!.data).toEqual(Buffer.concat([start, delta]));
      expect(frames[2]!.data).toEqual(frames[0]!.data);
    }
    const { parser, frames } = recorder();
    for (const byte of stream) parser.push(Buffer.from([byte]));
    parser.finish();
    expect(frames.map((frame) => frame.isKey)).toEqual(expected);
  });

  test("supports 1- and 2-byte NAL lengths, multiple NALs, and extended ISO box sizes", () => {
    for (const lengthBytes of [1, 2]) {
      const { parser, frames } = recorder();
      parser.push(movie(configuration(lengthBytes)));
      parser.push(sample([Buffer.from([9, 0xf0]), idr], lengthBytes, true));
      parser.finish();
      expect(frames).toEqual([{
        data: Buffer.concat([start, sps, start, pps, start, Buffer.from([9, 0xf0]), start, idr]),
        isKey: true,
      }]);
    }
  });

  test("rejects missing configuration and incomplete stream endings", () => {
    expect(() => recorder().parser.push(sample([idr]))).toThrow("before AVC configuration");
    for (const tail of [Buffer.from([0]), sample([idr]).subarray(0, -1)]) {
      const { parser } = recorder();
      parser.push(movie());
      parser.push(tail);
      expect(() => parser.finish()).toThrow("Truncated MP4 stream");
    }
  });

  test("rejects invalid ISO sizes before buffering their payload", () => {
    for (const size of [0, 7, 8 * 1024 * 1024 + 1]) {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(size);
      header.write("mdat", 4);
      expect(() => recorder().parser.push(header)).toThrow("MP4 box size");
    }
    const huge = Buffer.alloc(16);
    huge.writeUInt32BE(1);
    huge.write("mdat", 4);
    huge.writeBigUInt64BE(1n << 60n, 8);
    expect(() => recorder().parser.push(huge)).toThrow("MP4 box size");
  });

  test("rejects malformed configuration, child boxes, and NAL sample lengths", () => {
    expect(() => recorder().parser.push(movie(configuration(3)))).toThrow("Reserved AVC");
    expect(() => recorder().parser.push(movie(Buffer.alloc(7)))).toThrow("Invalid AVC");
    expect(() => recorder().parser.push(movie(configuration().subarray(0, -1)))).toThrow("parameter set");
    expect(() => recorder().parser.push(box("moov", Buffer.from([0, 0, 0, 99, 116, 114, 97, 107])))).toThrow("exceeds its parent");
    for (const payload of [Buffer.alloc(0), Buffer.from([0]), Buffer.alloc(4), Buffer.from([0, 0, 0, 9, 0x65])]) {
      const { parser, frames } = recorder();
      parser.push(movie());
      expect(() => parser.push(box("mdat", payload))).toThrow();
      expect(frames).toHaveLength(0);
    }
  });
});
