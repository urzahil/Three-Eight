// Random access to a local File without loading it into memory.

export class FileSource {
  /** @param {Blob} file */
  constructor(file, windowSize = file.remote ? 4 * 1024 * 1024 : 2 * 1024 * 1024) {
    this.file = file;
    this.size = file.size;
    this.windowSize = windowSize;
    // Remote files: start small so playback begins (and seeks land) quickly,
    // then grow to the full window while reading sequentially.
    this.ramp = file.remote ? Math.min(windowSize, 1024 * 1024) : windowSize;
    this.bufStart = 0;
    this.buf = new Uint8Array(0);
  }

  async read(pos, len) {
    const end = Math.min(this.size, pos + len);
    if (pos < 0 || pos >= end) return new Uint8Array(0);
    return new Uint8Array(await this.file.slice(pos, end).arrayBuffer());
  }

  /** Make sure [pos, pos+len) is in the window buffer. Returns false at EOF. */
  async ensure(pos, len) {
    if (pos >= this.bufStart && pos + len <= this.bufStart + this.buf.length) return true;
    if (pos >= this.size) return false;
    const want = Math.max(len, this.ramp);
    this.ramp = Math.min(this.windowSize, this.ramp * 2);
    this.buf = await this.read(pos, want);
    this.bufStart = pos;
    return pos + len <= this.bufStart + this.buf.length;
  }

  /** View into the window buffer (valid until the next ensure()). */
  view(pos, len) {
    const o = pos - this.bufStart;
    return this.buf.subarray(o, o + len);
  }

  byte(pos) {
    return this.buf[pos - this.bufStart];
  }

  available(pos) {
    return this.bufStart + this.buf.length - pos;
  }
}
