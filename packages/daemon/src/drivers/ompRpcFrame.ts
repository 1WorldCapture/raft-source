// OMP RPC framing (protocol docs: oh-my-pi docs/rpc.md "Transport and Framing";
// validation mirrors the official RpcFrameDecoder in
// packages/coding-agent/src/modes/rpc/rpc-frame.ts, reimplemented here because
// the omp SDK is Bun-only and cannot be imported by the Node daemon).
//
// Protocol v1 stdout frames are one JSON object per line with a 1 MiB physical
// cap (newline included). After `negotiate_protocol` to v2, oversized logical
// frames arrive as an uninterrupted `rpc_chunk` sequence: each chunk carries a
// strict-canonical base64 segment of the UTF-8 JSON object. Inbound frames
// (our stdin) are never chunked — sends stay single-line and must fit the
// physical limit.

export const MAX_OMP_RPC_FRAME_BYTES = 1024 * 1024;
export const MAX_OMP_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/** Per-chunk payload cap the official encoder uses (256 KiB segments). */
const OMP_RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

/** chunkId is a short correlation string; the official decoder allows 1..128. */
const MAX_OMP_RPC_CHUNK_ID_LENGTH = 128;

export interface OmpRpcChunkFrame {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

export class OmpRpcFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpRpcFrameError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcChunkFrame(value: unknown): value is OmpRpcChunkFrame {
  return isRecord(value) && value.type === "rpc_chunk";
}

function decodeBase64(data: unknown): Buffer {
  if (
    typeof data !== "string"
    || data.length === 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    throw new OmpRpcFrameError("invalid rpc chunk data");
  }
  const bytes = Buffer.from(data, "base64");
  // Canonicality check: a non-canonical encoding round-trips differently.
  if (bytes.toString("base64") !== data) throw new OmpRpcFrameError("invalid rpc chunk data");
  return bytes;
}

export interface OmpRpcDecoderOptions {
  /**
   * Physical per-line cap. Protocol v1 caps stdout frames at 1 MiB including
   * the newline; v2 chunk frames are individually small and stay under it.
   */
  maxPhysicalFrameBytes?: number;
  /**
   * Reassembled logical-frame cap; the ready frame advertises it
   * (maxReassembledFrameBytes). Defaults to the protocol maximum.
   */
  maxReassembledFrameBytes?: number;
}

/**
 * Reassemble protocol v2 chunk frames after each JSONL line has been parsed.
 * Non-chunk lines pass through unchanged; chunk sequences must be contiguous,
 * correctly ordered, and match their declared metadata exactly.
 */
export class OmpRpcFrameDecoder {
  #pending?: {
    chunkId: string;
    count: number;
    byteLength: number;
    nextIndex: number;
    chunks: Buffer[];
    receivedBytes: number;
  };
  #maxPhysicalFrameBytes: number;
  #maxReassembledFrameBytes: number;

  constructor(options: OmpRpcDecoderOptions = {}) {
    this.#maxPhysicalFrameBytes = options.maxPhysicalFrameBytes ?? MAX_OMP_RPC_FRAME_BYTES;
    this.#maxReassembledFrameBytes = options.maxReassembledFrameBytes ?? MAX_OMP_RPC_REASSEMBLED_BYTES;
  }

  get reassembling(): boolean {
    return this.#pending !== undefined;
  }

  /** Update the reassembly cap from the ready frame's advertisement. */
  setMaxReassembledFrameBytes(bytes: number): void {
    if (Number.isSafeInteger(bytes) && bytes > 0) {
      this.#maxReassembledFrameBytes = bytes;
    }
  }

  pushLine(line: string): object | undefined {
    if (Buffer.byteLength(line, "utf8") + 1 > this.#maxPhysicalFrameBytes) {
      this.#pending = undefined;
      throw new OmpRpcFrameError("rpc frame exceeds the physical transport limit");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new OmpRpcFrameError(`rpc frame is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.push(value);
  }

  /** Decode one parsed JSON value; chunk sequences return undefined until complete. */
  push(value: unknown): object | undefined {
    if (!isRpcChunkFrame(value)) {
      if (this.#pending) {
        this.#pending = undefined;
        throw new OmpRpcFrameError("rpc chunk sequence interrupted");
      }
      if (!isRecord(value)) throw new OmpRpcFrameError("rpc frame must be an object");
      return value;
    }

    const { chunkId, index, count, byteLength } = value;
    if (
      typeof chunkId !== "string"
      || chunkId.length === 0
      || chunkId.length > MAX_OMP_RPC_CHUNK_ID_LENGTH
      || !Number.isSafeInteger(index)
      || !Number.isSafeInteger(count)
      || !Number.isSafeInteger(byteLength)
      || index < 0
      || count < 2
      || count > Math.ceil(MAX_OMP_RPC_REASSEMBLED_BYTES / OMP_RPC_CHUNK_PAYLOAD_BYTES)
      || index >= count
      || byteLength < this.#maxPhysicalFrameBytes
      || byteLength > this.#maxReassembledFrameBytes
    ) {
      this.#pending = undefined;
      throw new OmpRpcFrameError("invalid rpc chunk metadata");
    }

    let bytes: Buffer;
    try {
      bytes = decodeBase64(value.data);
    } catch (error) {
      this.#pending = undefined;
      throw error;
    }
    if (bytes.byteLength > OMP_RPC_CHUNK_PAYLOAD_BYTES) {
      this.#pending = undefined;
      throw new OmpRpcFrameError("rpc chunk payload exceeds the transport limit");
    }

    if (!this.#pending) {
      if (index !== 0) throw new OmpRpcFrameError("rpc chunk sequence must start at index 0");
      this.#pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }
    const pending = this.#pending;
    if (
      pending.chunkId !== chunkId
      || pending.count !== count
      || pending.byteLength !== byteLength
      || pending.nextIndex !== index
    ) {
      this.#pending = undefined;
      throw new OmpRpcFrameError("rpc chunk sequence mismatch");
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;
    if (pending.receivedBytes > pending.byteLength) {
      this.#pending = undefined;
      throw new OmpRpcFrameError("rpc chunk sequence exceeds declared length");
    }
    if (pending.nextIndex < pending.count) return undefined;

    if (pending.receivedBytes !== pending.byteLength) {
      this.#pending = undefined;
      throw new OmpRpcFrameError("rpc chunk sequence length mismatch");
    }

    this.#pending = undefined;
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    } catch (error) {
      throw new OmpRpcFrameError(`rpc chunk sequence is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
    }
    let frame: unknown;
    try {
      frame = JSON.parse(decoded);
    } catch (error) {
      throw new OmpRpcFrameError(`reassembled rpc frame is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(frame)) throw new OmpRpcFrameError("rpc frame must be an object");
    return frame;
  }
}

export interface OmpRpcEncoderOptions {
  /** Physical per-line cap for outbound frames (newline included). */
  maxPhysicalFrameBytes?: number;
}

/**
 * Encode one outbound frame as a single JSONL line. Our stdin frames are never
 * chunked (the protocol does not reassemble inbound frames), so a frame that
 * cannot fit the physical limit is an encode error, not a send.
 */
export function encodeOmpRpcFrame(frame: object, options: OmpRpcEncoderOptions = {}): string {
  const maxPhysicalFrameBytes = options.maxPhysicalFrameBytes ?? MAX_OMP_RPC_FRAME_BYTES;
  const line = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(line, "utf8") > maxPhysicalFrameBytes) {
    throw new OmpRpcFrameError("outbound rpc frame exceeds the physical transport limit");
  }
  return line;
}
