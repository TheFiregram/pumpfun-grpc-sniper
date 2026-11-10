import { PublicKey } from "@solana/web3.js";

/** Minimal little-endian Borsh reader. Throws RangeError if the buffer runs out. */
export class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private need(n: number) {
    if (this.offset + n > this.buf.length) {
      throw new RangeError(`borsh: need ${n} bytes at ${this.offset}, have ${this.remaining}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  string(): string {
    this.need(4);
    const len = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    this.need(len);
    const s = this.buf.subarray(this.offset, this.offset + len).toString("utf8");
    this.offset += len;
    return s;
  }

  pubkey(): PublicKey {
    this.need(32);
    const pk = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return pk;
  }

  skip(n: number) {
    this.need(n);
    this.offset += n;
  }

  /** Read an optional trailing field: returns `fallback` if the struct was written by an older program version. */
  optional<T>(read: () => T, fallback: T): T {
    return this.remaining > 0 ? read() : fallback;
  }
}

export function u64Le(v: bigint): Buffer {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new RangeError(`u64 out of range: ${v}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
