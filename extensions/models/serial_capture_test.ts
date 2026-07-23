/**
 * Unit tests for the rolling-capture engine (Design B).
 *
 * The offset/eviction/rotation arithmetic is pure and is exercised here with no
 * hardware, no socat, and no drainer — exactly the seam the design promises. The
 * file-backed reader (`readFileBytes` / `readCaptureRange` via `dd`/`stat`) and
 * the ring read-forward cursor (`ringReadPort`) are exercised against real
 * temp-file fixtures we grow ourselves — still no hardware. The drainer + socat
 * spawn and the live read-path fork are NOT faked (no injection seam); they are
 * proven on the board at the test stage.
 *
 * Run: `~/.swamp/deno/deno test --allow-read --allow-write --allow-run \
 *   --allow-env extensions/models/serial_capture_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { drainUntil, execOn, type SerialPort } from "./serial_port.ts";
import {
  captureBytes,
  type CaptureThresholds,
  computeReadPlan,
  concatBytes,
  fileSize,
  indexOfBytes,
  prevCapturePath,
  readCaptureRange,
  readFileBytes,
  redactSecretInRing,
  retainedStart,
  ringReadPort,
  rotationThresholds,
  sessionCapturePath,
  shouldRotate,
  toBase64,
} from "./serial_capture.ts";

// ── Pure threshold helpers ──────────────────────────────────────────────────

Deno.test("retainedStart and captureBytes derive from the two thresholds", () => {
  const t: CaptureThresholds = { captureBase: 100, prevSize: 40, currentSize: 25 };
  assertEquals(retainedStart(t), 60); // captureBase − prevSize
  assertEquals(captureBytes(t), 125); // captureBase + currentSize
});

// ── computeReadPlan ─────────────────────────────────────────────────────────

Deno.test("computeReadPlan: fresh read of a single (un-rotated) file", () => {
  const t: CaptureThresholds = { captureBase: 0, prevSize: 0, currentSize: 50 };
  const p = computeReadPlan(t, 0, 1024);
  assertEquals(p.fromOffset, 0);
  assertEquals(p.nextOffset, 50);
  assertEquals(p.evicted, false);
  assertEquals(p.segments, [{ file: "current", start: 0, len: 50 }]);
});

Deno.test("computeReadPlan: resume from a mid-stream cursor", () => {
  const t: CaptureThresholds = { captureBase: 0, prevSize: 0, currentSize: 50 };
  const p = computeReadPlan(t, 30, 1024);
  assertEquals(p.fromOffset, 30);
  assertEquals(p.nextOffset, 50);
  assertEquals(p.segments, [{ file: "current", start: 30, len: 20 }]);
});

Deno.test("computeReadPlan: maxBytes truncation resumes mid-stream (nextOffset != EOF)", () => {
  const t: CaptureThresholds = { captureBase: 0, prevSize: 0, currentSize: 200 };
  const p = computeReadPlan(t, 10, 64);
  assertEquals(p.fromOffset, 10);
  assertEquals(p.nextOffset, 74); // 10 + 64, NOT captureBytes(200)
  assertEquals(p.segments, [{ file: "current", start: 10, len: 64 }]);
});

Deno.test("computeReadPlan: caught up (cursor at EOF) returns nothing, not evicted", () => {
  const t: CaptureThresholds = { captureBase: 0, prevSize: 0, currentSize: 50 };
  const p = computeReadPlan(t, 50, 1024);
  assertEquals(p.fromOffset, 50);
  assertEquals(p.nextOffset, 50);
  assertEquals(p.evicted, false);
  assertEquals(p.segments, []);
});

Deno.test("computeReadPlan: CAP-8 — an out-of-range-high sinceOffset clamps to EOF, not the future", () => {
  const t: CaptureThresholds = { captureBase: 0, prevSize: 0, currentSize: 50 };
  const p = computeReadPlan(t, 5000, 1024); // way past the stream end
  assertEquals(p.fromOffset, 50); // clamped down to captureBytes, NOT 5000
  assertEquals(p.nextOffset, 50); // cursor pinned to EOF, so no silent stall
  assertEquals(p.evicted, false);
  assertEquals(p.segments, []);
});

Deno.test("computeReadPlan: the .1 range [retainedStart, captureBase) is readable, NOT evicted", () => {
  // captureBase=100, prevSize=40 → retainedStart=60. Reading from 70 (inside .1)
  // must NOT be flagged evicted — the classic off-by-one-file the single-scalar
  // design would get wrong.
  const t: CaptureThresholds = { captureBase: 100, prevSize: 40, currentSize: 30 };
  const p = computeReadPlan(t, 70, 1024);
  assertEquals(p.evicted, false);
  assertEquals(p.fromOffset, 70);
  assertEquals(p.nextOffset, 130); // reads .1 tail then all of current
  // 70..100 in .1 (file pos 70−60=10, len 30), then 100..130 in current (0..30).
  assertEquals(p.segments, [
    { file: "prev", start: 10, len: 30 },
    { file: "current", start: 0, len: 30 },
  ]);
});

Deno.test("computeReadPlan: a rotation-spanning read splits into .1 then current", () => {
  const t: CaptureThresholds = { captureBase: 100, prevSize: 40, currentSize: 60 };
  // Read from retainedStart across the boundary with a cap that lands in current.
  const p = computeReadPlan(t, 60, 70);
  assertEquals(p.fromOffset, 60);
  assertEquals(p.nextOffset, 130); // 60 + 70
  assertEquals(p.segments, [
    { file: "prev", start: 0, len: 40 }, // 60..100 → .1 pos 0..40
    { file: "current", start: 0, len: 30 }, // 100..130 → current pos 0..30
  ]);
});

Deno.test("computeReadPlan: an evicted offset clamps fromOffset up to retainedStart", () => {
  const t: CaptureThresholds = { captureBase: 100, prevSize: 40, currentSize: 30 };
  // retainedStart=60; asking from 10 (rolled off) clamps up to 60.
  const p = computeReadPlan(t, 10, 1024);
  assertEquals(p.evicted, true);
  assertEquals(p.fromOffset, 60);
  assertEquals(p.nextOffset, 130);
  assertEquals(p.segments, [
    { file: "prev", start: 0, len: 40 },
    { file: "current", start: 0, len: 30 },
  ]);
});

Deno.test("computeReadPlan: deeply-evicted offset with tiny maxBytes → empty range, evicted", () => {
  const t: CaptureThresholds = { captureBase: 100, prevSize: 40, currentSize: 30 };
  // retainedStart=60; sinceOffset=10, maxBytes=5 → upper=15 < lower=60 → 0 bytes.
  const p = computeReadPlan(t, 10, 5);
  assertEquals(p.evicted, true);
  assertEquals(p.fromOffset, 60); // clamped up
  assertEquals(p.nextOffset, 60); // len clamped to 0, not upper−lower (negative)
  assertEquals(p.segments, []);
});

Deno.test("computeReadPlan: read entirely within .1 (no current segment)", () => {
  const t: CaptureThresholds = { captureBase: 100, prevSize: 40, currentSize: 30 };
  const p = computeReadPlan(t, 65, 20); // 65..85, all inside .1
  assertEquals(p.segments, [{ file: "prev", start: 5, len: 20 }]);
  assertEquals(p.nextOffset, 85);
});

// ── shouldRotate / rotationThresholds ───────────────────────────────────────

Deno.test("shouldRotate: fires when the CURRENT file crosses the bound", () => {
  assertEquals(
    shouldRotate({ captureBase: 0, prevSize: 0, currentSize: 500 }, 400),
    true,
  );
  assertEquals(
    shouldRotate({ captureBase: 0, prevSize: 0, currentSize: 400 }, 400),
    false,
  );
});

Deno.test("shouldRotate: CAP-1 regression — a huge captureBase with a tiny current does NOT rotate", () => {
  // The bug was gating on captureBytes=captureBase+currentSize (monotonic): once
  // the stream ever crossed the bound, every read re-rotated and discarded .1.
  // Gating on currentSize alone must return false here.
  assertEquals(
    shouldRotate({ captureBase: 5000, prevSize: 5000, currentSize: 1 }, 4000),
    false,
  );
  assertEquals(
    shouldRotate({ captureBase: 8_000_000, prevSize: 4_000_000, currentSize: 10 }, 4_194_304),
    false,
  );
});

Deno.test("shouldRotate: never rotates an empty current file", () => {
  assertEquals(
    shouldRotate({ captureBase: 400, prevSize: 400, currentSize: 0 }, 100),
    false,
  );
});

Deno.test("rotationThresholds: current becomes .1; retainedStart = old captureBase", () => {
  const th = rotationThresholds(500, 600); // captureBase=500, final currentSize=600
  assertEquals(th.newCaptureBase, 1100);
  assertEquals(th.newPrevSize, 600);
  const after: CaptureThresholds = {
    captureBase: th.newCaptureBase,
    prevSize: th.newPrevSize,
    currentSize: 0,
  };
  assertEquals(retainedStart(after), 500); // the new .1 starts at the old base
});

// ── toBase64 ────────────────────────────────────────────────────────────────

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.test("toBase64: round-trips arbitrary bytes (incl. control + high bytes)", () => {
  for (const len of [0, 1, 2, 3, 4, 5, 255, 256, 1000]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 13) & 0xff;
    assertEquals(b64decode(toBase64(bytes)), bytes, `round-trip len=${len}`);
  }
});

Deno.test("toBase64: matches the reference encoder", () => {
  const bytes = new TextEncoder().encode("panic: kernel\x00\x1b[0m\n");
  assertEquals(toBase64(bytes), btoa(String.fromCharCode(...bytes)));
});

// ── concatBytes ─────────────────────────────────────────────────────────────

Deno.test("concatBytes joins chunks in order", () => {
  assertEquals(
    concatBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]),
    new Uint8Array([1, 2, 3]),
  );
});

// ── File-backed reader (dd/stat over real temp files) ───────────────────────

async function writeFixture(path: string, bytes: Uint8Array): Promise<void> {
  await Deno.writeFile(path, bytes);
}
function ramp(len: number, seed = 0): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i + seed) & 0xff;
  return b;
}

Deno.test("fileSize reports byte length and 0 for a missing file", async () => {
  const f = await Deno.makeTempFile();
  try {
    await writeFixture(f, ramp(123));
    assertEquals(await fileSize(f), 123);
    assertEquals(await fileSize(f + ".nope"), 0);
  } finally {
    await Deno.remove(f);
  }
});

Deno.test("readFileBytes reads an exact window at a byte offset", async () => {
  const f = await Deno.makeTempFile();
  try {
    const data = ramp(300);
    await writeFixture(f, data);
    assertEquals(await readFileBytes(f, 0, 10), data.subarray(0, 10));
    assertEquals(await readFileBytes(f, 50, 100), data.subarray(50, 150));
    // Spanning past EOF returns only what exists (fullblock → up to EOF).
    assertEquals(await readFileBytes(f, 280, 100), data.subarray(280, 300));
    // Offset at/after EOF returns empty; zero/negative len returns empty.
    assertEquals(await readFileBytes(f, 300, 100), new Uint8Array(0));
    assertEquals(await readFileBytes(f, 10, 0), new Uint8Array(0));
  } finally {
    await Deno.remove(f);
  }
});

Deno.test("readCaptureRange assembles a rotation-spanning read from .1 + current", async () => {
  const current = await Deno.makeTempFile();
  const prev = prevCapturePath(current);
  try {
    // .1 holds stream [60,100) (prevSize=40), current holds [100,160).
    const prevBytes = ramp(40, 7);
    const curBytes = ramp(60, 200);
    await writeFixture(prev, prevBytes);
    await writeFixture(current, curBytes);
    const t: CaptureThresholds = { captureBase: 100, prevSize: 40, currentSize: 60 };
    const plan = computeReadPlan(t, 60, 70); // 60..130, spans the boundary
    const got = await readCaptureRange(current, prev, plan);
    assertEquals(got, concatBytes([prevBytes.subarray(0, 40), curBytes.subarray(0, 30)]));
  } finally {
    await Deno.remove(current);
    await Deno.remove(prev);
  }
});

Deno.test("capture_read shape: readCaptureRange + toBase64 round-trip over a fixture", async () => {
  const current = await Deno.makeTempFile();
  try {
    const curBytes = ramp(500, 3);
    await writeFixture(current, curBytes);
    const t: CaptureThresholds = { captureBase: 0, prevSize: 0, currentSize: 500 };
    const plan = computeReadPlan(t, 100, 128); // page of 128 from offset 100
    const got = await readCaptureRange(current, prevCapturePath(current), plan);
    assertEquals(got, curBytes.subarray(100, 228));
    assertEquals(b64decode(toBase64(got)), got);
  } finally {
    await Deno.remove(current);
  }
});

// ── ringReadPort: forward cursor over a growing ring file ────────────────────

function stubPty(writes: Uint8Array[]): SerialPort {
  return {
    write: (bytes: Uint8Array) => {
      writes.push(bytes);
      return Promise.resolve(bytes.length);
    },
    read: () => Promise.resolve(0),
    close: () => {},
  };
}

Deno.test("ringReadPort reads forward from the ring end and resumes after appends", async () => {
  const ring = await Deno.makeTempFile();
  try {
    // Seed the ring with pre-existing capture the interactive read must NOT see:
    // it starts at the CURRENT end, so only bytes appended after the write count.
    await writeFixture(ring, ramp(100));
    const writes: Uint8Array[] = [];
    const port = await ringReadPort(stubPty(writes), ring);

    // Writes go to the PTY (socat → device), not the ring.
    await port.write(new TextEncoder().encode("uname -r\n"));
    assertEquals(writes.length, 1);

    // Nothing appended yet → read yields 0 (drainUntil treats this as idle).
    const buf = new Uint8Array(4096);
    assertEquals(await port.read(buf), 0);

    // The drainer appends the response; the port reads it forward.
    const resp = new TextEncoder().encode("6.16.4\n");
    await Deno.writeFile(ring, resp, { append: true });
    const n = await port.read(buf);
    assertEquals(n, resp.length);
    assertEquals(buf.subarray(0, n as number), resp);

    // Caught up again → 0; a further append resumes from the advanced cursor.
    assertEquals(await port.read(buf), 0);
    const more = new TextEncoder().encode("done\n");
    await Deno.writeFile(ring, more, { append: true });
    const n2 = await port.read(buf);
    assertEquals(buf.subarray(0, n2 as number), more);
  } finally {
    await Deno.remove(ring);
  }
});

// ── Interactive read-forward over a growing ring (design B.4) ───────────────

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

Deno.test("execOn over ringReadPort: a sentinel landing mid-file matches and stops", async () => {
  const ring = await Deno.makeTempFile();
  try {
    await writeFixture(ring, ramp(80)); // pre-existing bytes the port must skip
    const writes: Uint8Array[] = [];
    const port = await ringReadPort(stubPty(writes), ring);
    // The drainer captures the echoed command + response + RC sentinel + prompt.
    const resp = new TextEncoder().encode(
      "uname -r\n6.16.4\n__RC:0:RC__\n[fedora@host ~]$ ",
    );
    await Deno.writeFile(ring, resp, { append: true });
    const r = await execOn(
      port,
      {
        command: "uname -r",
        lineEnding: "\n",
        prompt: /__RC:\d+:RC__/,
        idleMs: 500,
        maxMs: 5000,
        stripEcho: false,
      },
      fakeClock(),
    );
    assertEquals(r.matchedPrompt, true);
    assertEquals(writes.length, 1); // the command went to the PTY, not the ring
    assertEquals(r.output.includes("6.16.4"), true);
    assertEquals(r.output.includes("__RC:0:RC__"), true);
  } finally {
    await Deno.remove(ring);
  }
});

Deno.test("drainUntil over ringReadPort: short reads across 4096 boundaries accumulate to the sentinel", async () => {
  const ring = await Deno.makeTempFile();
  try {
    await writeFixture(ring, new Uint8Array(0));
    const writes: Uint8Array[] = [];
    const port = await ringReadPort(stubPty(writes), ring);
    const big = new Uint8Array(10000).fill(0x2e); // '.', spans 3 read chunks
    const tail = new TextEncoder().encode("END$ ");
    await Deno.writeFile(ring, concatBytes([big, tail]), { append: true });
    const { output, matched } = await drainUntil(
      port,
      { idleMs: 500, maxMs: 5000, stopRegex: /END\$ $/ },
      fakeClock(),
    );
    assertEquals(matched, true);
    assertEquals(output.length, 10005);
  } finally {
    await Deno.remove(ring);
  }
});

Deno.test("computeReadPlan: an offset recorded before a rotation resolves through the captureBase bump", () => {
  // Cursor 50 recorded when captureBase=0. The file holding [0,100) rotates to
  // .1 → captureBase=100, prevSize=100. Offset 50 must still resolve into .1.
  const before: CaptureThresholds = {
    captureBase: 0,
    prevSize: 0,
    currentSize: 100,
  };
  assertEquals(computeReadPlan(before, 50, 1024).segments, [
    { file: "current", start: 50, len: 50 },
  ]);
  const after: CaptureThresholds = {
    captureBase: 100,
    prevSize: 100,
    currentSize: 20,
  };
  const p = computeReadPlan(after, 50, 1024);
  assertEquals(p.evicted, false);
  assertEquals(p.segments, [
    { file: "prev", start: 50, len: 50 },
    { file: "current", start: 0, len: 20 },
  ]);
});

// ── Secret redaction (CAP-2) ────────────────────────────────────────────────

Deno.test("indexOfBytes finds, misses, and honours the from-offset", () => {
  const hay = new TextEncoder().encode("abcXYZabcXYZ");
  const nee = new TextEncoder().encode("XYZ");
  assertEquals(indexOfBytes(hay, nee), 3);
  assertEquals(indexOfBytes(hay, nee, 4), 9);
  assertEquals(indexOfBytes(hay, nee, 10), -1);
  assertEquals(indexOfBytes(hay, new TextEncoder().encode("nope")), -1);
  assertEquals(indexOfBytes(hay, new Uint8Array(0)), -1);
});

Deno.test("redactSecretInRing overwrites the secret in place, preserving offsets", async () => {
  const ring = await Deno.makeTempFile();
  try {
    const pre = new TextEncoder().encode("boot log line\n"); // before login span
    const login = new TextEncoder().encode(
      "login: fedora\nPassword: hunter2\n[fedora@host ~]$ ",
    );
    await Deno.writeFile(ring, concatBytes([pre, login]));
    const sizeBefore = await fileSize(ring);
    const n = await redactSecretInRing(ring, pre.length, "hunter2");
    assertEquals(n, 1);
    assertEquals(await fileSize(ring), sizeBefore); // offset-preserving
    const text = new TextDecoder().decode(await readFileBytes(ring, 0, sizeBefore));
    assertEquals(text.includes("hunter2"), false); // secret gone
    assertEquals(text.includes("*******"), true); // equal-length redaction
    assertEquals(text.startsWith("boot log line\n"), true); // pre-span untouched
  } finally {
    await Deno.remove(ring);
  }
});

Deno.test("redactSecretInRing redacts a secret past the pipe-buffer boundary in a large tail (NEW-1)", async () => {
  // The write-back dd pipes the whole tail through stdin; without iflag=fullblock
  // a >64 KiB tail would truncate and leave the trailing secret in plaintext.
  const ring = await Deno.makeTempFile();
  try {
    const filler = new Uint8Array(300_000).fill(0x2e); // '.', well past 64 KiB
    const secret = new TextEncoder().encode("s3cr3t-tail-pw");
    const trailer = new TextEncoder().encode("\n[fedora@host ~]$ ");
    // Secret sits ~300 KB into the tail, past any single pipe read.
    await Deno.writeFile(ring, concatBytes([filler, secret, trailer]));
    const sizeBefore = await fileSize(ring);
    const n = await redactSecretInRing(ring, 0, "s3cr3t-tail-pw");
    assertEquals(n, 1);
    assertEquals(await fileSize(ring), sizeBefore); // offset-preserving
    // Read the WHOLE file back and confirm the secret is gone on DISK, not just
    // in the first pipe-read's worth of bytes.
    const whole = await readFileBytes(ring, 0, sizeBefore);
    assertEquals(indexOfBytes(whole, secret), -1); // truly overwritten
    // The equal-length redaction landed at the right place.
    const stars = new Uint8Array(secret.length).fill(0x2a);
    assertEquals(indexOfBytes(whole, stars) >= 0, true);
  } finally {
    await Deno.remove(ring);
  }
});

Deno.test("redactSecretInRing is a no-op for an absent or empty secret", async () => {
  const ring = await Deno.makeTempFile();
  try {
    await Deno.writeFile(ring, new TextEncoder().encode("no secrets here\n"));
    assertEquals(await redactSecretInRing(ring, 0, "absent"), 0);
    assertEquals(await redactSecretInRing(ring, 0, ""), 0);
  } finally {
    await Deno.remove(ring);
  }
});

// ── Path helpers ────────────────────────────────────────────────────────────

Deno.test("sessionCapturePath is deterministic, sanitised, and .1-siblinged", () => {
  const p = sessionCapturePath("/dev/ttyUSB0");
  assertEquals(p.endsWith("/swamp-serial-_dev_ttyUSB0.cap"), true);
  assertEquals(prevCapturePath(p), p + ".1");
});
