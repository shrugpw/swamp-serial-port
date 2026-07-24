/**
 * Unit tests for @shrug/serial-port.
 *
 * Drives the hardware-agnostic protocol logic (drainUntil / execOn / loginOn)
 * against a scripted fake SerialPort and a fake Clock — NO device required.
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_port_test.ts`
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  assertAllowedDevice,
  ByteQueue,
  type Clock,
  deviceAllowlistCheck,
  drainUntil,
  ESCAPE_RE,
  execOn,
  framingArgs,
  isAllowedDevice,
  isPermissionError,
  loginOn,
  makeDirectTransport,
  makeSubprocessTransport,
  mergeConfig,
  scrubSecret,
  selectTransport,
  sendLine,
  type SerialPort,
  sessionPtyPath,
  socatDeviceOpts,
  stripEchoedCommand,
  stripEscapes,
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
 * A scripted serial port. Returns each queued chunk on successive reads, then
 * reports "no data" (0). Every read advances the clock, modelling syscall time
 * so idle/max timers make progress. `infinite` repeats the last chunk forever
 * (for max-cap tests). Records everything written.
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

// ── framingArgs ─────────────────────────────────────────────────────────────

Deno.test("framingArgs — 8N1 is cs8 no-parity 1-stop", () => {
  assertEquals(framingArgs("8N1"), ["cs8", "-parenb", "-cstopb"]);
});

Deno.test("framingArgs — 7E1 enables even parity", () => {
  assertEquals(framingArgs("7E1"), ["cs7", "parenb", "-parodd", "-cstopb"]);
});

Deno.test("framingArgs — 7O2 is odd parity, 2 stop bits", () => {
  assertEquals(framingArgs("7O2"), ["cs7", "parenb", "parodd", "cstopb"]);
});

Deno.test("framingArgs — rejects garbage", () => {
  assertThrows(() => framingArgs("9Z3"), Error, "Invalid framing");
});

// ── device allow-list ───────────────────────────────────────────────────────

Deno.test("isAllowedDevice — accepts real serial tty paths", () => {
  for (
    const d of [
      "/dev/ttyUSB0",
      "/dev/ttyUSB12",
      "/dev/ttyACM1",
      "/dev/ttyS0",
      "/dev/serial/by-id/usb-FTDI_A-if00-port0",
    ]
  ) {
    assertEquals(isAllowedDevice(d), true, d);
  }
});

Deno.test("isAllowedDevice — rejects non-serial and pty targets", () => {
  for (
    const d of [
      "/dev/pts/3",
      "/dev/console",
      "/dev/tty",
      "/etc/passwd",
      "ttyUSB0",
      "",
      "/dev/ttyUSB0; rm -rf /",
      // Path traversal via the serial/ branch must NOT escape /dev.
      "/dev/serial/../../etc/shadow",
      "/dev/serial/./../../root/.ssh/authorized_keys",
    ]
  ) {
    assertEquals(isAllowedDevice(d), false, d);
  }
});

Deno.test("assertAllowedDevice — throws on a pty (login password exfil guard)", () => {
  assertThrows(
    () => assertAllowedDevice("/dev/pts/7"),
    Error,
    "Refusing device",
  );
});

// ── deviceAllowlistCheck (pre-flight) ────────────────────────────────────────

Deno.test("deviceAllowlistCheck — labels + appliesTo are wired for skipping", () => {
  const check = deviceAllowlistCheck(["send", "login"])["device-allowlisted"];
  assertEquals(check.labels, ["policy"]);
  assertEquals(check.appliesTo, ["send", "login"]);
});

Deno.test("deviceAllowlistCheck — passes for an allowed tty path", () => {
  const check = deviceAllowlistCheck(["send"])["device-allowlisted"];
  assertEquals(check.execute({ globalArgs: { device: "/dev/ttyUSB0" } }), {
    pass: true,
  });
});

Deno.test("deviceAllowlistCheck — fails a mutating method aimed at a non-tty path", () => {
  const check = deviceAllowlistCheck(["send"])["device-allowlisted"];
  const res = check.execute({ globalArgs: { device: "/dev/pts/7" } });
  assertEquals(res.pass, false);
  assertMatch(res.errors?.[0] ?? "", /not an allowed serial tty path/);
});

Deno.test("deviceAllowlistCheck — defers to the in-method guard when device is unset", () => {
  // At `validate` time globalArgs are unpopulated; the check must not fail then.
  const check = deviceAllowlistCheck(["send"])["device-allowlisted"];
  assertEquals(check.execute({ globalArgs: {} }), { pass: true });
});

// ── mergeConfig precedence ──────────────────────────────────────────────────

Deno.test("mergeConfig — arg > port resource > global", () => {
  const g = {
    device: "/dev/ttyUSB0",
    baud: 115200,
    framing: "8N1",
    lineEnding: "\n",
    transport: "auto" as const,
  };
  const resource = { baud: 9600, framing: "7E1", lineEnding: "\r" };
  // No args: inherit everything from the establish-recorded resource.
  assertEquals(mergeConfig(g, resource, {}), {
    device: "/dev/ttyUSB0",
    baud: 9600,
    framing: "7E1",
    lineEnding: "\r",
  });
  // Arg wins over resource; unset fields still inherit the resource.
  assertEquals(mergeConfig(g, resource, { baud: 57600 }), {
    device: "/dev/ttyUSB0",
    baud: 57600,
    framing: "7E1",
    lineEnding: "\r",
  });
  // No resource: fall back to the global defaults (PortConfig subset only).
  assertEquals(mergeConfig(g, null, {}), {
    device: "/dev/ttyUSB0",
    baud: 115200,
    framing: "8N1",
    lineEnding: "\n",
  });
});

// ── ByteQueue (subprocess reader plumbing) ──────────────────────────────────

Deno.test("ByteQueue — splits a chunk larger than the read buffer", () => {
  const q = new ByteQueue();
  q.push(new Uint8Array([1, 2, 3, 4, 5]));
  assertEquals(q.length, 5);
  const buf = new Uint8Array(2);
  assertEquals(q.take(buf), 2);
  assertEquals([...buf], [1, 2]);
  assertEquals(q.take(buf), 2);
  assertEquals([...buf], [3, 4]);
  assertEquals(q.take(buf), 1);
  assertEquals(buf[0], 5);
  assertEquals(q.length, 0);
  assertEquals(q.take(buf), 0); // drained
});

Deno.test("ByteQueue — coalesces across multiple chunks into one read", () => {
  const q = new ByteQueue();
  q.push(new Uint8Array([1, 2]));
  q.push(new Uint8Array([3, 4]));
  q.push(new Uint8Array([5]));
  const buf = new Uint8Array(4);
  assertEquals(q.take(buf), 4);
  assertEquals([...buf], [1, 2, 3, 4]);
  const buf2 = new Uint8Array(4);
  assertEquals(q.take(buf2), 1);
  assertEquals(buf2[0], 5);
});

Deno.test("ByteQueue — ignores empty pushes, take on empty is 0", () => {
  const q = new ByteQueue();
  q.push(new Uint8Array([]));
  assertEquals(q.length, 0);
  assertEquals(q.take(new Uint8Array(8)), 0);
});

// ── transport selection ─────────────────────────────────────────────────────

Deno.test("selectTransport — each mode yields a configure+open transport", () => {
  for (const mode of ["auto", "direct", "subprocess"] as const) {
    const t = selectTransport(mode);
    assertEquals(typeof t.configure, "function", mode);
    assertEquals(typeof t.open, "function", mode);
  }
  // direct and subprocess are distinct implementations.
  const a = makeDirectTransport();
  const b = makeSubprocessTransport();
  assertEquals(a.open === b.open, false);
});

// ── session holder ──────────────────────────────────────────────────────────

Deno.test("socatDeviceOpts — maps framing to socat serial options", () => {
  const opts = (framing: string, baud = 115200) =>
    socatDeviceOpts({
      device: "/dev/ttyUSB0",
      baud,
      framing,
      lineEnding: "\n",
    });
  // 8N1: 8 bits, no parity, 1 stop bit; raw, no echo, no flow control, no hangup.
  assertEquals(
    opts("8N1"),
    "raw,echo=0,b115200,cs8,parenb=0,cstopb=0,clocal=1,crtscts=0,hupcl=0",
  );
  // 7E2: even parity (parenb + parodd=0), 2 stop bits.
  assertEquals(
    opts("7E2", 9600),
    "raw,echo=0,b9600,cs7,parenb=1,parodd=0,cstopb=1,clocal=1,crtscts=0,hupcl=0",
  );
  // Odd parity sets parodd=1.
  assertMatch(opts("8O1"), /parenb=1,parodd=1/);
});

Deno.test("socatDeviceOpts — rejects malformed framing", () => {
  assertThrows(
    () =>
      socatDeviceOpts({
        device: "/dev/ttyUSB0",
        baud: 115200,
        framing: "9N1",
        lineEnding: "\n",
      }),
    Error,
    "Invalid framing",
  );
});

Deno.test("sessionPtyPath — derives a stable, sanitised PTY link path", () => {
  assertEquals(
    sessionPtyPath("/dev/ttyUSB0"),
    "/tmp/swamp-serial-_dev_ttyUSB0.pty",
  );
  // Same device → same path (so separate runs find the same holder).
  assertEquals(sessionPtyPath("/dev/ttyUSB0"), sessionPtyPath("/dev/ttyUSB0"));
  // No shell metacharacters survive sanitisation.
  assertMatch(
    sessionPtyPath("/dev/serial/by-id/usb-x.y"),
    /^\/tmp\/swamp-serial-[\w-]+\.pty$/,
  );
});

Deno.test("isPermissionError — detects Deno permission denials", () => {
  assertEquals(isPermissionError(new Deno.errors.PermissionDenied("x")), true);
  assertEquals(
    isPermissionError(
      new Error(
        'Requires all access to "/dev/ttyUSB0", specify ... --allow-all',
      ),
    ),
    true,
  );
  assertEquals(isPermissionError(new Error("some other failure")), false);
});

// ── drainUntil ──────────────────────────────────────────────────────────────

Deno.test("drainUntil — captures data then stops on idle", async () => {
  const clock = new FakeClock();
  const port = new FakePort(["hello ", "world"], clock);
  const { output, matched } = await drainUntil(
    port,
    { idleMs: 300, maxMs: 5000 },
    clock,
  );
  assertEquals(output, "hello world");
  assertEquals(matched, false);
});

Deno.test("drainUntil — stops early when stopRegex matches", async () => {
  const clock = new FakeClock();
  const port = new FakePort(["Linux device\n", "[operator@device ~]$ "], clock);
  const { output, matched } = await drainUntil(
    port,
    { idleMs: 300, maxMs: 5000, stopRegex: /\$ $/ },
    clock,
  );
  assertMatch(output, /\$ $/);
  assertEquals(matched, true);
});

Deno.test("drainUntil — banner '#'/'$' chars do NOT trigger the default prompt", async () => {
  const clock = new FakeClock();
  // A hash-box MOTD dribbles in before the real shell prompt. The default
  // prompt regex requires a trailing space, so the box lines must NOT stop it.
  const port = new FakePort(
    [
      "#############\n",
      "# Banana Pi #\n",
      "#############\n",
      "[operator@device ~]$ ",
    ],
    clock,
  );
  const { output, matched } = await drainUntil(
    port,
    { idleMs: 300, maxMs: 5000, stopRegex: /[$#>] $/ },
    clock,
  );
  assertEquals(matched, true);
  // Proof it read PAST the banner rather than stopping on a '#'.
  assertMatch(output, /Banana Pi/);
  assertMatch(output, /\$ $/);
});

Deno.test("drainUntil — honours the max cap on a chatty port", async () => {
  const clock = new FakeClock();
  // Never idles (infinite data), never matches; must break on maxMs.
  const port = new FakePort(["....."], clock, {
    infinite: true,
    readCostMs: 50,
  });
  const { matched } = await drainUntil(
    port,
    { idleMs: 300, maxMs: 1000, stopRegex: /NEVER/ },
    clock,
  );
  assertEquals(matched, false);
  assertEquals(clock.now() >= 1000, true);
});

Deno.test("drainUntil — empty port returns empty without spinning", async () => {
  const clock = new FakeClock();
  const port = new FakePort([], clock);
  const { output } = await drainUntil(
    port,
    { idleMs: 200, maxMs: 5000 },
    clock,
  );
  assertEquals(output, "");
  // Idle reached via bounded sleeps, not an unbounded spin.
  assertEquals(clock.now() >= 200, true);
});

// ── sendLine ────────────────────────────────────────────────────────────────

Deno.test("sendLine — appends the configured line ending", async () => {
  const clock = new FakeClock();
  const port = new FakePort([], clock);
  const n = await sendLine(port, "uname -a", {
    lineEnding: "\n",
    appendNewline: true,
  });
  assertEquals(port.writes, ["uname -a\n"]);
  assertEquals(n, "uname -a\n".length);
});

Deno.test("sendLine — raw send omits the line ending", async () => {
  const clock = new FakeClock();
  const port = new FakePort([], clock);
  await sendLine(port, "\x03", { lineEnding: "\n", appendNewline: false });
  assertEquals(port.writes, ["\x03"]);
});

Deno.test("sendLine — respects a carriage-return line ending", async () => {
  const clock = new FakeClock();
  const port = new FakePort([], clock);
  await sendLine(port, "ls", { lineEnding: "\r", appendNewline: true });
  assertEquals(port.writes, ["ls\r"]);
});

// ── stripEchoedCommand ──────────────────────────────────────────────────────

Deno.test("stripEchoedCommand — removes the leading echoed line", () => {
  const out = stripEchoedCommand("uname -a\r\nLinux device\r\n", "uname -a");
  assertEquals(out, "Linux device\r\n");
});

Deno.test("stripEchoedCommand — clears a CR-CR-LF residue (CR line ending)", () => {
  // With lineEnding "\r" the device echoes "ls\r" then "\r\nfile1"; the whole
  // leading CR/LF run must be stripped, not just a single "\r?\n".
  const out = stripEchoedCommand("ls\r\r\nfile1\r\n", "ls");
  assertEquals(out, "file1\r\n");
});

Deno.test("stripEchoedCommand — leaves output without an echo intact", () => {
  const out = stripEchoedCommand("Linux device\r\n", "uname -a");
  assertEquals(out, "Linux device\r\n");
});

// ── execOn ──────────────────────────────────────────────────────────────────

Deno.test("execOn — sends command, strips echo, stops on prompt", async () => {
  const clock = new FakeClock();
  const port = new FakePort(
    ["uname -a\r\n", "Linux device 6.1.0 riscv64\r\n", "[operator@device ~]$ "],
    clock,
  );
  const { output, matchedPrompt } = await execOn(
    port,
    {
      command: "uname -a",
      lineEnding: "\n",
      prompt: /\$ $/,
      idleMs: 500,
      maxMs: 10000,
      stripEcho: true,
    },
    clock,
  );
  assertEquals(port.writes[0], "uname -a\n");
  assertMatch(output, /^Linux device 6\.1\.0 riscv64/);
  assertEquals(matchedPrompt, true);
});

Deno.test("execOn — keeps the echo when stripEcho is false", async () => {
  const clock = new FakeClock();
  const port = new FakePort(["echo hi\r\nhi\r\n"], clock);
  const { output } = await execOn(
    port,
    {
      command: "echo hi",
      lineEnding: "\n",
      idleMs: 300,
      maxMs: 5000,
      stripEcho: false,
    },
    clock,
  );
  assertMatch(output, /^echo hi/);
});

// ── scrubSecret ─────────────────────────────────────────────────────────────

Deno.test("scrubSecret — redacts the password wherever it appears", () => {
  assertEquals(scrubSecret("pw=hunter2 done", "hunter2"), "pw=«redacted» done");
});

Deno.test("scrubSecret — no-op when no secret given", () => {
  assertEquals(scrubSecret("nothing here", undefined), "nothing here");
});

// ── loginOn ─────────────────────────────────────────────────────────────────

Deno.test("loginOn — full getty flow succeeds and hides the password", async () => {
  const clock = new FakeClock();
  const port = new FakePort(
    [
      "\r\ndevice login: ",
      "Password: ",
      "\r\nLast login: ...\r\n[operator@device ~]$ ",
    ],
    clock,
  );
  const { status, transcript } = await loginOn(
    port,
    {
      username: "operator",
      password: "hunter2",
      lineEnding: "\n",
      idleMs: 300,
      maxMs: 5000,
    },
    clock,
  );
  assertEquals(status, "ok");
  assertEquals(port.writes, ["\n", "operator\n", "hunter2\n"]);
  // Password must never leak into the recorded transcript.
  assertEquals(transcript.includes("hunter2"), false);
});

Deno.test("loginOn — status is decided before scrubbing (password with '$')", async () => {
  const clock = new FakeClock();
  // The remote does not echo the password, but the prompt char '$' also happens
  // to be in the password; scrubbing must not delete the prompt from the
  // decision. Status is computed on the raw transcript, so it stays "ok".
  const port = new FakePort(
    ["\r\ndevice login: ", "Password: ", "\r\n[operator@device ~]$ "],
    clock,
  );
  const { status, transcript } = await loginOn(
    port,
    {
      username: "operator",
      password: "p$ss",
      lineEnding: "\n",
      idleMs: 300,
      maxMs: 5000,
    },
    clock,
  );
  assertEquals(status, "ok");
  assertEquals(transcript.includes("p$ss"), false);
});

Deno.test("loginOn — already at a shell prompt is ok without logging in", async () => {
  const clock = new FakeClock();
  const port = new FakePort(["\r\n[operator@device ~]$ "], clock);
  const { status } = await loginOn(
    port,
    {
      username: "operator",
      password: "hunter2",
      lineEnding: "\n",
      idleMs: 300,
      maxMs: 5000,
    },
    clock,
  );
  assertEquals(status, "ok");
  // Only the nudge newline — no username/password sent.
  assertEquals(port.writes, ["\n"]);
});

Deno.test("loginOn — wrong credentials report failed", async () => {
  const clock = new FakeClock();
  const port = new FakePort(
    [
      "\r\ndevice login: ",
      "Password: ",
      "\r\nLogin incorrect\r\n\r\ndevice login: ",
    ],
    clock,
  );
  const { status, transcript } = await loginOn(
    port,
    {
      username: "operator",
      password: "wrong",
      lineEnding: "\n",
      idleMs: 300,
      maxMs: 5000,
    },
    clock,
  );
  assertEquals(status, "failed");
  assertMatch(transcript, /Login incorrect/);
});

// ── Escape-sequence scrubbing (the F43 agetty handshake) ─────────────────────

// Fedora 43's newer agetty emits this burst at the login/shell prompt: a DSR
// cursor-position query (CSI `ESC[6n`) plus `OSC 3008` serial-getty metadata
// (BEL-terminated). Before the scrub was consolidated into `stopWindow`, this
// tail defeated every end-anchored prompt regex → `withSession` login threw →
// the cfgmgmt exec/package methods returned no status on an F43 board.
const F43_BURST = "\x1b[6n\x1b]3008;serial-getty@ttyS0.service\x07";

Deno.test("stripEscapes — removes CSI, OSC (BEL+ST), DCS and charset escapes", () => {
  // CSI colour + DSR query, OSC (both terminators), a DCS string, keypad/charset.
  assertEquals(stripEscapes("\x1b[0m\x1b[6nhi"), "hi");
  assertEquals(stripEscapes("a\x1b]0;title\x07b"), "ab");
  assertEquals(stripEscapes("a\x1b]52;c;x\x1b\\b"), "ab"); // ST-terminated OSC
  assertEquals(stripEscapes("a\x1bP1;2q...\x1b\\b"), "ab"); // DCS
  assertEquals(stripEscapes("\x1b(B\x1b=text"), "text"); // charset + keypad
  assertEquals(
    stripEscapes("[fedora@host ~]$ " + F43_BURST),
    "[fedora@host ~]$ ",
  );
  // Real text with no escapes is untouched.
  assertEquals(stripEscapes("plain login: "), "plain login: ");
  // Guard the regex is global (no leftover lastIndex state between calls).
  ESCAPE_RE.lastIndex = 5;
  assertEquals(stripEscapes("\x1b[6nx"), "x");
});

Deno.test("loginOn — tolerates the F43 agetty escape burst at every prompt (#7)", async () => {
  const clock = new FakeClock();
  const port = new FakePort(
    [
      "\r\nbpif3-004 login: " + F43_BURST,
      "Password: " + F43_BURST,
      "\r\nLast login: ...\r\n[fedora@bpif3-004 ~]$ " + F43_BURST,
    ],
    clock,
  );
  const { status } = await loginOn(
    port,
    {
      username: "fedora",
      password: "hunter2",
      lineEnding: "\n",
      idleMs: 300,
      maxMs: 5000,
    },
    clock,
  );
  assertEquals(status, "ok");
  assertEquals(port.writes, ["\n", "fedora\n", "hunter2\n"]);
});

Deno.test("drainUntil — stopRegex matches a prompt trailed by an escape burst", async () => {
  const clock = new FakeClock();
  const port = new FakePort(
    ["boot noise\r\n", "[fedora@bpif3-004 ~]$ " + F43_BURST],
    clock,
  );
  const { matched } = await drainUntil(
    port,
    { idleMs: 300, maxMs: 5000, stopRegex: /[$#>] $/ },
    clock,
  );
  assert(matched);
});
