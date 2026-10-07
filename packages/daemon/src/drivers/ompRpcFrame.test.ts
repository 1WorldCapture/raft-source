import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MAX_OMP_RPC_FRAME_BYTES,
  MAX_OMP_RPC_REASSEMBLED_BYTES,
  OmpRpcFrameDecoder,
  OmpRpcFrameError,
  encodeOmpRpcFrame,
} from "./ompRpcFrame.js";

function chunkFrame(chunkId: string, index: number, count: number, byteLength: number, data: string) {
  return { type: "rpc_chunk", chunkId, index, count, byteLength, data };
}

function chunkInto(frame: object, chunkId: string, chunkSize: number): object[] {
  const serialized = Buffer.from(JSON.stringify(frame), "utf8");
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < serialized.byteLength; offset += chunkSize) {
    pieces.push(serialized.subarray(offset, offset + chunkSize));
  }
  // The protocol only chunks frames that exceed the physical limit, so the
  // chunk tests run against decoders with a tiny physical cap; production
  // uses the 1 MiB default and only ever sees real oversized sequences.
  return pieces.map((piece, index) => chunkFrame(chunkId, index, pieces.length, serialized.byteLength, piece.toString("base64")));
}

/** Decoder with a small physical cap so hand-built sequences pass the metadata floor. */
function smallDecoder(): OmpRpcFrameDecoder {
  return new OmpRpcFrameDecoder({ maxPhysicalFrameBytes: 64 });
}

/** A frame whose serialized size clears the small physical-cap floor. */
function paddedFrame(type: string): object {
  return { type, blob: "x".repeat(96) };
}

test("pushLine decodes a plain JSONL frame", () => {
  const decoder = new OmpRpcFrameDecoder();
  const frame = decoder.pushLine(JSON.stringify({ type: "ready", protocolVersion: 1 }));
  assert.deepEqual(frame, { type: "ready", protocolVersion: 1 });
});

test("pushLine rejects malformed JSON and non-object frames as frame errors", () => {
  const decoder = new OmpRpcFrameDecoder();
  assert.throws(() => decoder.pushLine("{not json"), OmpRpcFrameError);
  assert.throws(() => decoder.pushLine("[1,2,3]"), /must be an object/);
});

test("pushLine rejects lines beyond the physical frame cap", () => {
  const decoder = new OmpRpcFrameDecoder({ maxPhysicalFrameBytes: 64 });
  assert.throws(() => decoder.pushLine(JSON.stringify({ pad: "x".repeat(128) })), /physical transport limit/);
});

test("chunk sequences reassemble into one logical frame in index order", () => {
  const decoder = smallDecoder();
  const big = { type: "response", command: "get_state", success: true, data: { blob: "y".repeat(200) } };
  const chunks = chunkInto(big, "rpc-1", 64);
  assert.ok(chunks.length >= 2);

  const intermediates = chunks.slice(0, -1).map((chunk) => decoder.push(chunk));
  for (const intermediate of intermediates) assert.equal(intermediate, undefined);
  const final = decoder.push(chunks[chunks.length - 1]);
  assert.deepEqual(final, big);
  assert.equal(decoder.reassembling, false);
});

test("a non-chunk frame while a sequence is open is an interruption", () => {
  const decoder = smallDecoder();
  const chunks = chunkInto(paddedFrame("agent_start"), "rpc-2", 48);
  decoder.push(chunks[0]);
  assert.throws(() => decoder.push({ type: "ready", protocolVersion: 1 }), /interrupted/);
  // The failed sequence is dropped; the next frame decodes normally.
  assert.deepEqual(decoder.push({ type: "agent_start" }), { type: "agent_start" });
});

test("chunk sequences must start at index 0 and stay contiguous", () => {
  const chunks = chunkInto(paddedFrame("agent_start"), "rpc-3", 48);
  assert.ok(chunks.length >= 2);

  const decoder = smallDecoder();
  assert.throws(() => decoder.push(chunks[1]), /must start at index 0/);

  const decoder2 = smallDecoder();
  decoder2.push(chunks[0]);
  assert.throws(() => decoder2.push(chunks[0]), /mismatch/);
});

test("chunk metadata mismatches are rejected", () => {
  const decoder = smallDecoder();
  const chunks = chunkInto(paddedFrame("agent_start"), "rpc-4", 48);
  decoder.push(chunks[0]);
  // Same index, different chunkId.
  const renamed = { ...chunks[1], chunkId: "rpc-other" } as unknown as Parameters<OmpRpcFrameDecoder["push"]>[0];
  assert.throws(() => decoder.push(renamed), /mismatch/);
});

test("corrupt base64 and non-canonical encodings are rejected", () => {
  const decoder = smallDecoder();
  assert.throws(() => decoder.push(chunkFrame("rpc-5", 0, 2, MAX_OMP_RPC_FRAME_BYTES, "not+base64!!")), /invalid rpc chunk data/);
});

test("declared byteLength mismatches the reassembled bytes are rejected", () => {
  const decoder = smallDecoder();
  const payload = Buffer.from(JSON.stringify(paddedFrame("agent_start")), "utf8");
  const real = payload.byteLength;
  const half = Math.ceil(real / 2);
  // Both chunks declare the same inflated length, so the metadata checks pass
  // and the failure surfaces at completion: reassembled != declared.
  const declared = real + 10;
  const first = chunkFrame("rpc-6", 0, 2, declared, payload.subarray(0, half).toString("base64"));
  const last = chunkFrame("rpc-6", 1, 2, declared, payload.subarray(half).toString("base64"));
  decoder.push(first);
  assert.throws(() => decoder.push(last), /length mismatch/);
});

test("a sequence exceeding the reassembly cap is rejected", () => {
  const decoder = new OmpRpcFrameDecoder({
    maxPhysicalFrameBytes: 2048,
    maxReassembledFrameBytes: 4096,
  });
  // Declared byteLength sits under the cap, but the chunks sum past it.
  const payload = "z".repeat(4096);
  decoder.push(chunkFrame("rpc-7", 0, 2, 3000, Buffer.from(payload.slice(0, 2048)).toString("base64")));
  assert.throws(() => decoder.push(chunkFrame("rpc-7", 1, 2, 3000, Buffer.from(payload.slice(2048)).toString("base64"))), /exceeds declared length/);
});

test("setMaxReassembledFrameBytes keeps megabyte-scale logical frames reassembling", () => {
  const decoder = new OmpRpcFrameDecoder();
  decoder.setMaxReassembledFrameBytes(MAX_OMP_RPC_REASSEMBLED_BYTES);
  // A logical frame far past one physical frame reassembles losslessly.
  const big = { type: "response", command: "x", success: true, data: { blob: "w".repeat(1024 * 1024 + 4096) } };
  const chunks = chunkInto(big, "rpc-8", 256 * 1024);
  assert.ok(chunks.length >= 2);
  let final: object | undefined;
  for (const chunk of chunks) final = decoder.push(chunk);
  assert.deepEqual(final, big);
});

test("encodeOmpRpcFrame emits one JSONL line and rejects oversize frames", () => {
  const line = encodeOmpRpcFrame({ type: "prompt", message: "hello" });
  assert.equal(line, '{"type":"prompt","message":"hello"}\n');

  assert.throws(
    () => encodeOmpRpcFrame({ type: "prompt", message: "x".repeat(MAX_OMP_RPC_FRAME_BYTES) }),
    OmpRpcFrameError,
  );
});
