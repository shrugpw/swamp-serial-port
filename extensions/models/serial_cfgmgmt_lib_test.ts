/**
 * Unit tests for the @shrug/serial-cfgmgmt/* shared library.
 *
 * Drives the transport-agnostic console logic — output cleaning, exit-code
 * parsing, settle/drain, and the session-attach decision — against a scripted
 * fake port. Type-specific parsing (facts/package/service) and the exec key
 * sanitizer live in the per-model sibling `_test.ts` files. NO device required.
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_cfgmgmt_lib_test.ts`
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  cleanOutput,
  ioDeviceFor,
  RC_RE,
  settle,
  splitExitCode,
  withSession,
} from "./serial_cfgmgmt_lib.ts";
import {
  type Clock,
  execOn,
  type SerialPort,
  sessionLinkLive,
  sessionPtyPath,
} from "./serial_port.ts";

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A deterministic clock; time only moves when we advance it. */
class FakeClock implements Clock {
  ms = 0;
  now(): number {
    return this.ms;
  }
  sleep(ms: number): Promise<void> {
    this.ms += ms;
    return Promise.resolve();
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/**
 * A scripted serial port (same shape as serial_port_test's fake): returns each
 * queued chunk on successive reads, then reports "no data" (0). Every read
 * advances the clock so idle/max timers make progress. `infinite` repeats the
 * last chunk forever. Records everything written.
 */
class FakePort implements SerialPort {
  writes: string[] = [];
  closed = false;
  private i = 0;
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  constructor(
    private chunks: string[],
    private clock: FakeClock,
    private opts: { readCostMs?: number; infinite?: boolean } = {},
  ) {}
  write(bytes: Uint8Array): Promise<number> {
    this.writes.push(this.dec.decode(bytes));
    return Promise.resolve(bytes.length);
  }
  read(buf: Uint8Array): Promise<number | null> {
    this.clock.advance(this.opts.readCostMs ?? 10);
    let chunk: string | undefined;
    if (this.i < this.chunks.length) chunk = this.chunks[this.i++];
    else if (this.opts.infinite) chunk = this.chunks[this.chunks.length - 1];
    if (chunk === undefined) return Promise.resolve(0);
    const bytes = this.enc.encode(chunk);
    buf.set(bytes.subarray(0, buf.length));
    return Promise.resolve(Math.min(bytes.length, buf.length));
  }
  close(): void {
    this.closed = true;
  }
}

// ── cleanOutput ──────────────────────────────────────────────────────────────

Deno.test("cleanOutput strips ANSI, echoed command, and trailing prompt", () => {
  // Real capture shape from a bracketed-paste bash console.
  const raw =
    "\x1b[?2004luname -srm\r\nLinux 6.16.4-200.spacemit.fc42.riscv64 riscv64\r\n" +
    "\x1b[?2004h\x1b[?2004l[user@host ~]$ ";
  assertEquals(
    cleanOutput(raw, "uname -srm"),
    "Linux 6.16.4-200.spacemit.fc42.riscv64 riscv64",
  );
});

Deno.test("cleanOutput keeps multi-line stdout intact", () => {
  const raw = "cat file\r\nID=fedora\r\nVERSION_ID=42\r\n[root@x ~]# ";
  assertEquals(cleanOutput(raw, "cat file"), "ID=fedora\nVERSION_ID=42");
});

Deno.test("cleanOutput strips the F43 agetty OSC/DSR burst (#7)", () => {
  // F43's agetty interleaves a DSR cursor query (CSI) and OSC-3008 metadata
  // (BEL-terminated) — the OSC escaped the old CSI-only strip and leaked into
  // stdout and the prompt tail. The consolidated scrub removes both.
  const burst = "\x1b[6n\x1b]3008;serial-getty@ttyS0.service\x07";
  const raw = "cat /etc/os-release\r\nVERSION_ID=43\r\n[fedora@bpif3-004 ~]$ " +
    burst;
  assertEquals(cleanOutput(raw, "cat /etc/os-release"), "VERSION_ID=43");
});

Deno.test("cleanOutput drops a residual prompt glued onto the echoed command", () => {
  // A prompt left un-drained by loginOn glues onto the pty echo of the next
  // command; the real output follows. Only "fedora" should survive.
  const raw = "[user@host ~]$ id -un\r\nfedora\r\n[user@host ~]$ ";
  assertEquals(cleanOutput(raw, "id -un"), "fedora");
});

// ── splitExitCode ────────────────────────────────────────────────────────────

Deno.test("splitExitCode extracts the RC sentinel and strips it from stdout", () => {
  assertEquals(splitExitCode("hello\n__RC:0:RC__"), {
    stdout: "hello",
    exitCode: 0,
  });
  assertEquals(splitExitCode("__RC:1:RC__"), { stdout: "", exitCode: 1 });
  assertEquals(splitExitCode("no sentinel here"), {
    stdout: "no sentinel here",
    exitCode: null,
  });
});

Deno.test("splitExitCode truncates at the sentinel, dropping a trailing partial prompt", () => {
  // Regression: `drainUntil` stops on the RC sentinel but returns the whole
  // buffer, so the final chunk can carry the next prompt AFTER the sentinel. A
  // full prompt is dropped by cleanOutput; a partial one (`[user@host ~`, no
  // closing `]$ `) is not, and previously bled into stdout because splitExitCode
  // only deleted the sentinel token. Live-observed on a getty: a captured
  // `mktemp -d` path came back as "/tmp/.swamp-dnf.o1zo5w\n[fedora@bpif3-004 ~",
  // whose embedded newline then corrupted every downstream command.
  assertEquals(
    splitExitCode("/tmp/.swamp-dnf.o1zo5w\n__RC:0:RC__\n[fedora@bpif3-004 ~"),
    { stdout: "/tmp/.swamp-dnf.o1zo5w", exitCode: 0 },
  );
  // Same guarantee for a single scalar (the releaseVersion "42\n[fedora@…" bleed).
  assertEquals(
    splitExitCode("42\n__RC:0:RC__\n[fedora@bpif3-004"),
    { stdout: "42", exitCode: 0 },
  );
});

// ── settle ───────────────────────────────────────────────────────────────────

Deno.test("settle drains buffered bytes to quiet, then leaves the port empty", async () => {
  const clock = new FakeClock();
  const port = new FakePort(["[user@host ~]$ "], clock);
  const swept = await settle(port, { settleMs: 300, maxMs: 5000 }, clock);
  assertEquals(swept, "[user@host ~]$ ");
  // A second settle sees nothing — the buffer was fully consumed.
  assertEquals(await settle(port, { settleMs: 300, maxMs: 5000 }, clock), "");
});

Deno.test("settle returns after settleMs of idle on a quiet line", async () => {
  const clock = new FakeClock();
  const port = new FakePort([], clock);
  assertEquals(await settle(port, { settleMs: 300, maxMs: 5000 }, clock), "");
  // Idle bound reached, hard cap not hit.
  assertEquals(clock.now() < 5000, true);
});

Deno.test("settle stops at maxMs on a console that never goes quiet", async () => {
  const clock = new FakeClock();
  const port = new FakePort(["printk noise "], clock, { infinite: true });
  const swept = await settle(port, { settleMs: 300, maxMs: 1000 }, clock);
  assertEquals(swept.length > 0, true);
  assertEquals(clock.now() >= 1000, true); // bounded, did not hang
});

// ── session attach decision ──────────────────────────────────────────────────

Deno.test("ioDeviceFor redirects to the PTY only when a holder is live", () => {
  const dev = "/dev/ttyUSB9";
  // No live holder → open the real device (open/close per call, unchanged).
  assertEquals(ioDeviceFor(dev, false), dev);
  // Live holder → open its deterministic PTY link instead of the device.
  assertEquals(ioDeviceFor(dev, true), sessionPtyPath(dev));
});

Deno.test("sessionLinkLive is true only for a link to an existing target", async () => {
  const dev = "/dev/ttyTEST-attach";
  const link = sessionPtyPath(dev); // deterministic, device-derived
  const target = await Deno.makeTempFile();
  try {
    // No link yet → not live (holder never started, or already reaped).
    assertEquals(await sessionLinkLive(dev), false);

    // Link → live target: a running holder's PTY is present → attach.
    await Deno.symlink(target, link);
    assertEquals(await sessionLinkLive(dev), true);

    // Holder died: its /dev/pts target vanishes, leaving a dangling link.
    // `test -e` follows the symlink, so this reads not-live → fall back.
    await Deno.remove(target);
    assertEquals(await sessionLinkLive(dev), false);
  } finally {
    await Deno.remove(link).catch(() => {});
    await Deno.remove(target).catch(() => {});
  }
});

Deno.test("requireSession fails fast (no port opened) when no holder is live", async () => {
  // A device with no holder link → sessionLinkLive false. Strict mode must throw
  // before any port open, so this never touches hardware. /dev/ttyUSB7 is an
  // allowed path with (assumed) no live holder in the test environment.
  const g = {
    device: "/dev/ttyUSB7",
    baud: 115200,
    framing: "8N1",
    lineEnding: "\n",
    transport: "auto" as const,
    prompt: "[#$>] $",
    idleMs: 1000,
    maxMs: 15000,
    settleMs: 0,
    requireSession: true,
  };
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  await assertRejects(
    () =>
      withSession(
        g,
        logger as unknown as Parameters<typeof withSession>[1],
        () => Promise.resolve("unreached"),
      ),
    Error,
    "no live session holder",
  );
});

// ── sentinel-synced read ─────────────────────────────────────────────────────

Deno.test("RC-synced read skips a residual prompt and stops on the sentinel", async () => {
  const clock = new FakeClock();
  const cmd = 'id -un; echo "__RC:$?:RC__"';
  // Buffer opens with a STALE prompt (what loginOn strands). A prompt stop-regex
  // would false-match it and return empty; RC_RE must read through to the real
  // sentinel. Note the pty echo carries a literal "$?" (no digit), so RC_RE
  // skips it and matches only the executed "__RC:0:RC__".
  const port = new FakePort(
    [
      "[user@host ~]$ ", // residual prompt (stale)
      `${cmd}\r\n`, // pty echo of the wrapped command
      "fedora\r\n", // real output
      "__RC:0:RC__\r\n", // sentinel (digit → matches)
      "[user@host ~]$ ", // trailing prompt (should stay unread)
    ],
    clock,
  );
  const { output, matchedPrompt } = await execOn(
    port,
    {
      command: cmd,
      lineEnding: "\n",
      prompt: RC_RE,
      idleMs: 1000,
      maxMs: 15000,
      stripEcho: true,
    },
    clock,
  );
  assertEquals(matchedPrompt, true);
  assertEquals(splitExitCode(cleanOutput(output, cmd)), {
    stdout: "fedora",
    exitCode: 0,
  });
});
