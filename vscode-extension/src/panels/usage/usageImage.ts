/** Decode only bounded PNG exports produced by the Usage canvas. */
export function decodeUsagePng(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > 12_000_000 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Invalid usage image");
  }
  const bytes = Buffer.from(value.slice("data:image/png;base64,".length), "base64");
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) > 2160 || bytes.readUInt32BE(20) > 2160 ||
      bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) {
    throw new Error("Invalid usage image");
  }
  return bytes;
}
