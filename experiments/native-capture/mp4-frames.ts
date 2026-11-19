const MAX_BOX_BYTES = 8 * 1024 * 1024;
const START_CODE = Buffer.from([0, 0, 0, 1]);

type Box = { type: string; payload: Buffer };
type Configuration = { lengthBytes: number; parameterSets: Buffer };

/** Bounded ISO BMFF boxes; size=0 cannot delimit a box in a live stream. */
function boxSize(header: Buffer, headerBytes: number): number {
  const small = header.readUInt32BE(0);
  const size = small === 1 ? header.readBigUInt64BE(8) : BigInt(small);
  if (size < BigInt(headerBytes) || size > BigInt(MAX_BOX_BYTES)) {
    throw new Error("MP4 box size must include its header and be at most 8 MiB");
  }
  return Number(size);
}

function* boxes(data: Buffer): Generator<Box> {
  let offset = 0;
  while (offset < data.length) {
    if (data.length - offset < 8) throw new Error("Truncated MP4 box header");
    const headerBytes = data.readUInt32BE(offset) === 1 ? 16 : 8;
    if (data.length - offset < headerBytes) throw new Error("Truncated extended MP4 box header");
    const size = boxSize(data.subarray(offset, offset + headerBytes), headerBytes);
    if (size > data.length - offset) throw new Error("MP4 child box exceeds its parent");
    yield {
      type: data.toString("ascii", offset + 4, offset + 8),
      payload: data.subarray(offset + headerBytes, offset + size),
    };
    offset += size;
  }
}

function onlyChild(data: Buffer, type: string): Buffer {
  let found: Buffer | undefined;
  for (const box of boxes(data)) {
    if (box.type !== type) continue;
    if (found) throw new Error(`Multiple MP4 ${type} boxes are unsupported`);
    found = box.payload;
  }
  if (!found) throw new Error(`Missing MP4 ${type} box`);
  return found;
}

function avcConfiguration(data: Buffer): Configuration {
  if (data.length < 7 || data[0] !== 1) throw new Error("Invalid AVC decoder configuration");
  const lengthBytes = (data[4]! & 3) + 1;
  if (lengthBytes === 3) throw new Error("Reserved AVC NAL length size");
  let offset = 6;
  const sets: Buffer[] = [];
  const readSets = (count: number, expectedType: number) => {
    if (count < 1) throw new Error("AVC configuration requires SPS and PPS");
    for (let index = 0; index < count; index++) {
      if (data.length - offset < 2) throw new Error("Truncated AVC parameter set length");
      const size = data.readUInt16BE(offset);
      offset += 2;
      if (size < 1 || size > data.length - offset) throw new Error("Truncated AVC parameter set");
      if ((data[offset]! & 31) !== expectedType) throw new Error("Unexpected AVC parameter set type");
      sets.push(START_CODE, data.subarray(offset, offset + size));
      offset += size;
    }
  };
  readSets(data[5]! & 31, 7);
  if (offset >= data.length) throw new Error("Missing AVC PPS count");
  readSets(data[offset++]!, 8);
  // High-profile avcC records may have extension fields after the PPS list.
  return { lengthBytes, parameterSets: Buffer.concat(sets) };
}

function movieConfiguration(data: Buffer): Configuration {
  let container = data;
  for (const type of ["trak", "mdia", "minf", "stbl", "stsd"]) {
    container = onlyChild(container, type);
  }
  // stsd contains FullBox version/flags, entry_count, then sample entries.
  if (container.length < 8 || container[0] !== 0 || container.readUInt32BE(4) !== 1) {
    throw new Error("Expected one MP4 sample description");
  }
  const entries = [...boxes(container.subarray(8))];
  if (entries.length !== 1 || entries[0]!.type !== "avc1") {
    throw new Error("Expected one avc1 video sample entry");
  }
  const entry = entries[0]!.payload;
  // VisualSampleEntry has 78 fixed bytes after the ordinary box header.
  if (entry.length < 78) throw new Error("Truncated AVC visual sample entry");
  return avcConfiguration(onlyChild(entry.subarray(78), "avcC"));
}

function annexB(data: Buffer, config: Configuration): { data: Buffer; isKey: boolean } {
  const { lengthBytes, parameterSets } = config;
  if (!data.length) throw new Error("Empty MP4 video sample");
  let outputBytes = 0;
  let isKey = false;
  // First pass validates every NAL before allocating or emitting a frame.
  for (let offset = 0; offset < data.length;) {
    if (data.length - offset < lengthBytes) throw new Error("Truncated AVC NAL length");
    const size = data.readUIntBE(offset, lengthBytes);
    offset += lengthBytes;
    if (size < 1 || size > data.length - offset) throw new Error("Invalid AVC NAL length");
    isKey ||= (data[offset]! & 31) === 5;
    outputBytes += START_CODE.length + size;
    if (outputBytes > MAX_BOX_BYTES) throw new Error("Annex B frame exceeds 8 MiB");
    offset += size;
  }
  const prefixBytes = isKey ? parameterSets.length : 0;
  if (outputBytes + prefixBytes > MAX_BOX_BYTES) throw new Error("Annex B frame exceeds 8 MiB");
  const output = Buffer.allocUnsafe(outputBytes + prefixBytes);
  if (isKey) parameterSets.copy(output);
  let destination = prefixBytes;
  for (let offset = 0; offset < data.length;) {
    const size = data.readUIntBE(offset, lengthBytes);
    offset += lengthBytes;
    START_CODE.copy(output, destination);
    destination += START_CODE.length;
    data.copy(output, destination, offset, offset + size);
    destination += size;
    offset += size;
  }
  return { data: output, isKey };
}

/**
 * FFmpeg fragmented MP4 with one AVC video sample per mdat, one track, no
 * B-frames. Emit at the end of each mdat; no subsequent frame is required.
 * Configure FFmpeg with empty_moov+default_base_moof+frag_every_frame.
 */
export class Mp4Frames {
  private readonly header = Buffer.alloc(16);
  private headerUsed = 0;
  private headerBytes = 8;
  private type: string | null = null;
  private payload: Buffer | null = null;
  private payloadSize = 0;
  private payloadUsed = 0;
  private config: Configuration | null = null;

  constructor(private readonly output: (data: Buffer, isKey: boolean) => void) {}

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.type === null) {
        const count = Math.min(this.headerBytes - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + count);
        this.headerUsed += count;
        offset += count;
        if (this.headerUsed < this.headerBytes) continue;
        if (this.headerBytes === 8 && this.header.readUInt32BE(0) === 1) {
          this.headerBytes = 16;
          continue;
        }
        const size = boxSize(this.header, this.headerBytes);
        this.type = this.header.toString("ascii", 4, 8);
        this.payloadSize = size - this.headerBytes;
        this.payloadUsed = 0;
        // Skip unneeded payloads (ftyp, moof, etc.) without retaining them.
        this.payload = this.type === "moov" || this.type === "mdat"
          ? Buffer.allocUnsafe(this.payloadSize)
          : null;
      }
      const count = Math.min(this.payloadSize - this.payloadUsed, chunk.length - offset);
      this.payload?.set(chunk.subarray(offset, offset + count), this.payloadUsed);
      offset += count;
      this.payloadUsed += count;
      if (this.payloadUsed === this.payloadSize) {
        const type = this.type;
        const payload = this.payload;
        this.type = null;
        this.payload = null;
        this.headerUsed = 0;
        this.headerBytes = 8;
        this.payloadUsed = this.payloadSize = 0;
        if (type === "moov") this.config = movieConfiguration(payload!);
        if (type === "mdat") {
          if (!this.config) throw new Error("MP4 video data arrived before AVC configuration");
          const frame = annexB(payload!, this.config);
          this.output(frame.data, frame.isKey);
        }
      }
    }
  }

  finish(): void {
    if (this.headerUsed || this.type !== null) throw new Error("Truncated MP4 stream");
  }
}
