/**
 * Unit tests for `@shrug/serial-cfgmgmt/file`.
 *
 * The transfer orchestration is pure over an injected `Session`, so the whole
 * push/pull/verify surface — including the design §8 corrupted-chunk-retry and
 * checksum-mismatch-failure cases — is exercised here against a scripted fake
 * session and an in-memory model of the target filesystem. NO device, no socat,
 * no real port.
 *
 * Run: `~/.swamp/deno/deno test --allow-read extensions/models/serial_cfgmgmt_file_test.ts`
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { type CommandResult, type Session } from "./serial_cfgmgmt_lib.ts";
import {
  appendChunkCmd,
  chunkBase64,
  extractBetweenMarkers,
  finalizeCmd,
  fromBase64,
  gunzipBytes,
  gzipBytes,
  moveCmd,
  pullViaSession,
  pushViaSession,
  resourceKey,
  sha256Hex,
  shq,
  stagingCreateCmd,
  stagingPathFor,
  tempDestFor,
  toBase64,
  truncateCmd,
  verifyViaSession,
} from "./serial_cfgmgmt_file.ts";

const ok = (stdout = ""): CommandResult => ({ stdout, exitCode: 0 });
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ── Pure helpers ─────────────────────────────────────────────────────────────

Deno.test("base64 round-trips arbitrary bytes including control chars", () => {
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 65, 66]);
  assertEquals(fromBase64(toBase64(bytes)), bytes);
});

Deno.test("fromBase64 ignores whitespace / CR / line wraps", () => {
  const b64 = toBase64(enc("hello world, this is a config line"));
  const wrapped = b64.replace(/(.{4})/g, "$1\n"); // inject newlines every 4 chars
  assertEquals(
    dec(fromBase64(wrapped + "\r\n  ")),
    "hello world, this is a config line",
  );
});

Deno.test("chunkBase64 splits at the line ceiling, last chunk short", () => {
  const chunks = chunkBase64("abcdefgh", 3);
  assertEquals(chunks, ["abc", "def", "gh"]);
  assertEquals(chunkBase64("", 3), []);
});

Deno.test("gzip/gunzip round-trips (and gunzip reads our own gzip)", async () => {
  const data = enc(
    "configuration=true\nrepeat repeat repeat repeat\n".repeat(20),
  );
  const gz = await gzipBytes(data);
  assert(gz.length < data.length, "should compress repetitive text");
  assertEquals(await gunzipBytes(gz), data);
});

Deno.test("sha256Hex matches a known vector", async () => {
  // echo -n "" | sha256sum
  assertEquals(
    await sha256Hex(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

Deno.test("extractBetweenMarkers ignores the echoed command line containing the markers", () => {
  const text = [
    "printf '%s\\n' '__SWAMP_XFER_BEGIN__'; gzip -c f | base64; printf '%s\\n' '__SWAMP_XFER_END__'",
    "__SWAMP_XFER_BEGIN__",
    "SGVsbG8=",
    "__SWAMP_XFER_END__",
  ].join("\n");
  assertEquals(
    extractBetweenMarkers(text, "__SWAMP_XFER_BEGIN__", "__SWAMP_XFER_END__"),
    "SGVsbG8=",
  );
});

Deno.test("shq neutralizes embedded single quotes", () => {
  assertEquals(shq("/tmp/a'b"), "'/tmp/a'\\''b'");
  assertEquals(
    appendChunkCmd("/tmp/s.b64", "QUJD"),
    "printf '%s\\n' 'QUJD' >> '/tmp/s.b64'",
  );
});

Deno.test("stagingPathFor is content-derived and .b64", () => {
  const p = stagingPathFor("deadbeefdeadbeef");
  assert(p.startsWith("/tmp/.swamp-xfer-deadbeefdead-"));
  assert(p.endsWith(".b64"));
});

Deno.test("resourceKey sanitizes and bounds", () => {
  assertEquals(resourceKey("/etc/nginx/nginx.conf"), "_etc_nginx_nginx_conf");
  assertEquals(resourceKey(""), "file");
});

// ── A fake target: an in-memory filesystem driven by the shell commands ──────

/**
 * Minimal shell emulator. Understands exactly the command shapes the module
 * emits: rm -f, printf ... >> staging, base64 -d [| gzip -d] > path, sha256sum,
 * the printk read, dmesg, chmod/chown. Enough to model a real transfer end-to-end.
 */
function fakeTarget(opts: {
  corruptChunk?: number; // 1-based chunk index to fail once
  tamperFinalize?: (bytes: Uint8Array) => Uint8Array; // mutate decoded bytes to force mismatch
  seed?: Record<string, Uint8Array>; // pre-existing remote files (for pull/verify)
} = {}): Session & {
  fs: Map<string, Uint8Array>;
  staging: Map<string, string>;
  calls: string[];
} {
  const fs = new Map<string, Uint8Array>(Object.entries(opts.seed ?? {}));
  const staging = new Map<string, string>(); // path -> accumulated base64 text
  const calls: string[] = [];
  const seen = new Map<number, number>(); // chunk failures already delivered
  let chunkNo = 0;

  async function sha(bytes: Uint8Array): Promise<string> {
    return await sha256Hex(bytes);
  }

  return {
    fs,
    staging,
    calls,
    async run(command: string): Promise<CommandResult> {
      calls.push(command);

      if (/^cat \/proc\/sys\/kernel\/printk/.test(command)) return ok("7");
      if (/^dmesg -n /.test(command)) return ok();

      let m: RegExpMatchArray | null;

      // Exclusive staging create: rm -f 'X' && (set -C; : > 'X')
      if (
        (m = command.match(
          /^rm -f '([^']+)' && \(set -C; : > '([^']+)'\)$/,
        ))
      ) {
        staging.set(m[2], "");
        return ok();
      }

      // truncate -s N 'X' — roll staging back to N bytes
      if ((m = command.match(/^truncate -s (\d+) '([^']+)'/))) {
        const n = Number(m[1]);
        staging.set(m[2], (staging.get(m[2]) ?? "").slice(0, n));
        return ok();
      }

      if ((m = command.match(/^rm -f '([^']+)'$/))) {
        staging.delete(m[1]);
        fs.delete(m[1]);
        return ok();
      }

      if ((m = command.match(/^printf '%s\\n' '([^']*)' >> '([^']+)'$/))) {
        chunkNo++;
        if (opts.corruptChunk === chunkNo && !seen.has(chunkNo)) {
          seen.set(chunkNo, 1);
          return { stdout: "", exitCode: 1 }; // transient failure → retried
        }
        staging.set(m[2], (staging.get(m[2]) ?? "") + m[1] + "\n");
        return ok();
      }

      // Decode staging into a TEMP dest (never the live path directly).
      if (
        (m = command.match(
          /base64 -d '([^']+)'(?: \| gzip -d)? > '([^']+)'/,
        ))
      ) {
        const isGzip = command.includes("| gzip -d");
        const b64 = staging.get(m[1]) ?? "";
        let bytes = fromBase64(b64);
        if (isGzip) bytes = await gunzipBytes(bytes);
        if (opts.tamperFinalize) bytes = opts.tamperFinalize(bytes);
        fs.set(m[2], bytes);
        return ok();
      }

      // Atomic swap: mv -f 'temp' 'remote'
      if ((m = command.match(/^mv -f '([^']+)' '([^']+)'$/))) {
        const src = fs.get(m[1]);
        if (src === undefined) return { stdout: "", exitCode: 1 };
        fs.set(m[2], src);
        fs.delete(m[1]);
        return ok();
      }

      if ((m = command.match(/^sha256sum '([^']+)'/))) {
        const f = fs.get(m[1]);
        if (!f) return { stdout: "", exitCode: 1 };
        return ok((await sha(f)) + "  " + m[1]);
      }

      if ((m = command.match(/^chmod '([^']+)' '([^']+)'/))) return ok();
      if ((m = command.match(/^chown '([^']+)' '([^']+)'/))) return ok();

      // pull existence probe: test -e 'X' && echo __SWAMP_EXISTS__
      if ((m = command.match(/^test -e '([^']+)' && echo __SWAMP_EXISTS__$/))) {
        return ok(fs.has(m[1]) ? "__SWAMP_EXISTS__" : "");
      }

      // pull: printf BEGIN; [gzip -c f |] base64 f; printf END
      if (command.includes("__SWAMP_XFER_BEGIN__")) {
        const pm = command.match(/(?:gzip -c|base64) '([^']+)'/);
        const path = pm?.[1] ?? "";
        const f = fs.get(path);
        if (f === undefined || f.length === 0) {
          return ok("__SWAMP_XFER_BEGIN__\n\n__SWAMP_XFER_END__");
        }
        const payload = command.includes("gzip -c") ? await gzipBytes(f) : f;
        const b64 = toBase64(payload).replace(/(.{76})/g, "$1\n");
        return ok(`__SWAMP_XFER_BEGIN__\n${b64}\n__SWAMP_XFER_END__`);
      }

      return { stdout: "", exitCode: 127 };
    },
  };
}

async function preparePush(
  session: Session,
  data: Uint8Array,
  gzip: boolean,
  extra: Partial<Parameters<typeof pushViaSession>[1]> = {},
) {
  const localSha = await sha256Hex(data);
  const payload = gzip ? await gzipBytes(data) : data;
  const chunks = chunkBase64(toBase64(payload), 768);
  return await pushViaSession(session, {
    chunks,
    stagingPath: stagingPathFor(localSha),
    remotePath: "/etc/app.conf",
    gzip,
    localSha,
    maxRetries: 3,
    quietConsole: true,
    ...extra,
  });
}

// ── push ─────────────────────────────────────────────────────────────────────

Deno.test("push happy path: file lands byte-identical, verified, staging removed", async () => {
  const data = enc("key=value\nother=thing\n");
  const t = fakeTarget();
  const res = await preparePush(t, data, true);
  assertEquals(res.verified, true);
  assertEquals(dec(t.fs.get("/etc/app.conf")!), "key=value\nother=thing\n");
  // staging file removed after a verified success
  assertEquals(t.staging.size, 0);
});

Deno.test("push retries a transiently-failing chunk then succeeds", async () => {
  const data = enc("A".repeat(2000)); // multiple 768-char chunks
  const t = fakeTarget({ corruptChunk: 2 });
  const res = await preparePush(t, data, true);
  assertEquals(res.verified, true);
  assertEquals(dec(t.fs.get("/etc/app.conf")!), "A".repeat(2000));
});

Deno.test("push fails on mismatch, LEAVES staging, and leaves the live target UNTOUCHED (FT-1)", async () => {
  const original = enc("ORIGINAL fstab — must survive a botched push\n");
  const data = enc("new content");
  const t = fakeTarget({
    seed: { "/etc/app.conf": original }, // a precious pre-existing target
    tamperFinalize: (b) => new Uint8Array([...b, 33]), // garble the decode
  });
  await assertRejects(
    () => preparePush(t, data, true),
    Error,
    "sha256 mismatch",
  );
  // The live target must be byte-for-byte what it was — never truncated/clobbered.
  assertEquals(dec(t.fs.get("/etc/app.conf")!), dec(original));
  // staging left for diagnosis; a decode temp was created but never moved into place
  assertEquals(t.staging.size, 1);
  assert(
    [...t.fs.keys()].some((k) => k.endsWith(".tmp")),
    "temp left for diagnosis",
  );
});

Deno.test("push applies mode/owner to the temp and only then moves into place", async () => {
  const data = enc("cfg=1\n");
  const t = fakeTarget();
  const res = await preparePush(t, data, true, {
    mode: "0640",
    owner: "root:root",
  });
  assertEquals(res.verified, true);
  // chmod/chown must target the .tmp (pre-rename), not the final path
  assert(t.calls.some((c) => /^chmod '0640' '.*\.tmp'$/.test(c)));
  assert(t.calls.some((c) => /^chown 'root:root' '.*\.tmp'$/.test(c)));
  // and the mv happens after both
  const iChmod = t.calls.findIndex((c) => c.startsWith("chmod"));
  const iMv = t.calls.findIndex((c) => c.startsWith("mv -f"));
  assert(iMv > iChmod);
  assertEquals(dec(t.fs.get("/etc/app.conf")!), "cfg=1\n");
});

Deno.test("push fails after exhausting retries on a persistently-failing chunk", async () => {
  // Simulate a persistently-failing append via a session that always fails the
  // `printf ... >>` and succeeds everything else (create/truncate/etc).
  const alwaysFail: Session = {
    run: (command: string) =>
      Promise.resolve(
        /printf .* >> /.test(command)
          ? { stdout: "", exitCode: 1 }
          : { stdout: "7", exitCode: 0 },
      ),
  };
  await assertRejects(
    () =>
      pushViaSession(alwaysFail, {
        chunks: ["AAAA", "BBBB"],
        stagingPath: "/tmp/s.b64",
        remotePath: "/etc/app.conf",
        gzip: true,
        localSha: "deadbeef",
        maxRetries: 2,
        quietConsole: false,
      }),
    Error,
    "after 3 attempts",
  );
});

Deno.test("push restores console level even when the transfer throws", async () => {
  const data = enc("cfg");
  const t = fakeTarget({ tamperFinalize: (b) => new Uint8Array([...b, 1]) });
  await assertRejects(() => preparePush(t, data, true));
  // the last dmesg call must be a restore to the read level (7), not left at 1
  const restore = t.calls.filter((c) => /^dmesg -n /.test(c)).pop();
  assertEquals(restore, "dmesg -n 7 2>/dev/null");
});

// ── pull ─────────────────────────────────────────────────────────────────────

Deno.test("pull round-trips a gzip'd remote file, sha256 verified", async () => {
  const original = enc("log line 1\nlog line 2\n");
  const t = fakeTarget({ seed: { "/var/log/app.log": original } });
  const res = await pullViaSession(t, {
    remotePath: "/var/log/app.log",
    gzip: true,
  });
  assertEquals(res.match, true);
  assertEquals(dec(res.bytes), "log line 1\nlog line 2\n");
});

Deno.test("pull works without gzip too", async () => {
  const original = enc("plain");
  const t = fakeTarget({ seed: { "/f": original } });
  const res = await pullViaSession(t, { remotePath: "/f", gzip: false });
  assertEquals(dec(res.bytes), "plain");
  assertEquals(res.match, true);
});

Deno.test("pull throws 'no such file' on a genuinely missing file", async () => {
  const t = fakeTarget();
  await assertRejects(
    () => pullViaSession(t, { remotePath: "/nope", gzip: true, maxRetries: 0 }),
    Error,
    "no such file",
  );
});

Deno.test("pull round-trips a legitimately EMPTY file (FT-4)", async () => {
  const t = fakeTarget({ seed: { "/etc/empty": new Uint8Array(0) } });
  const res = await pullViaSession(t, { remotePath: "/etc/empty", gzip: true });
  assertEquals(res.bytes.length, 0);
  assertEquals(res.match, true);
});

Deno.test("pull retries a printk-corrupted stream, then succeeds (FT-2)", async () => {
  const original = enc("clean payload\n");
  const t = fakeTarget({ seed: { "/f": original } });
  // Wrap run() to inject a garbage byte into the first pull's base64 stream only.
  const realRun = t.run.bind(t);
  let corrupted = false;
  t.run = (command: string) => {
    if (command.includes("__SWAMP_XFER_BEGIN__") && !corrupted) {
      corrupted = true;
      // valid-looking but wrong base64 between the markers → gunzip/sha fails
      return Promise.resolve(
        ok("__SWAMP_XFER_BEGIN__\nAAAA\n__SWAMP_XFER_END__"),
      );
    }
    return realRun(command);
  };
  const res = await pullViaSession(t, {
    remotePath: "/f",
    gzip: true,
    maxRetries: 3,
  });
  assertEquals(dec(res.bytes), "clean payload\n");
  assert(corrupted, "first attempt was corrupted");
});

// ── verify ───────────────────────────────────────────────────────────────────

Deno.test("verify reports match / mismatch without transferring", async () => {
  const data = enc("same");
  const t = fakeTarget({ seed: { "/etc/x": data } });
  const localSha = await sha256Hex(data);
  assertEquals(await verifyViaSession(t, { localSha, remotePath: "/etc/x" }), {
    match: true,
    remoteSha: localSha,
  });
  const bad = await verifyViaSession(t, {
    localSha: "00",
    remotePath: "/etc/x",
  });
  assertEquals(bad.match, false);
  assertEquals(bad.remoteSha, localSha);
});

Deno.test("verify reports no match when remote file is absent", async () => {
  const t = fakeTarget();
  assertEquals(
    await verifyViaSession(t, { localSha: "ab", remotePath: "/gone" }),
    {
      match: false,
      remoteSha: null,
    },
  );
});

// ── command builders ─────────────────────────────────────────────────────────

Deno.test("finalizeCmd decodes into a temp dest, gzip-aware and pipefail-guarded", () => {
  assertEquals(
    finalizeCmd("/tmp/s.b64", "/etc/app.conf.tmp", true),
    "set -o pipefail 2>/dev/null; base64 -d '/tmp/s.b64' | gzip -d > '/etc/app.conf.tmp'",
  );
  assertEquals(
    finalizeCmd("/tmp/s.b64", "/etc/app.conf.tmp", false),
    "set -o pipefail 2>/dev/null; base64 -d '/tmp/s.b64' > '/etc/app.conf.tmp'",
  );
});

Deno.test("tempDestFor is a same-directory sibling of the target (atomic mv)", () => {
  const tmp = tempDestFor("/etc/app.conf", "abcdef0123456789");
  assertEquals(tmp, "/etc/app.conf.swampxfer-abcdef012345.tmp");
  // sibling ⇒ same filesystem ⇒ mv is atomic
  assert(tmp.startsWith("/etc/"));
});

Deno.test("stagingCreateCmd removes then exclusively (set -C) creates", () => {
  assertEquals(
    stagingCreateCmd("/tmp/s.b64"),
    "rm -f '/tmp/s.b64' && (set -C; : > '/tmp/s.b64')",
  );
});

Deno.test("truncateCmd rolls staging back to a byte length", () => {
  assertEquals(
    truncateCmd("/tmp/s.b64", 42),
    "truncate -s 42 '/tmp/s.b64' 2>/dev/null",
  );
});

Deno.test("moveCmd is a forced same-fs rename", () => {
  assertEquals(moveCmd("/etc/x.tmp", "/etc/x"), "mv -f '/etc/x.tmp' '/etc/x'");
});

Deno.test("appendChunkCmd rejects a non-base64 chunk (SEC-3 injection guard)", () => {
  assertThrows(
    () => appendChunkCmd("/tmp/s.b64", "x'; rm -rf / ;'"),
    Error,
    "not pure base64",
  );
  // a real base64 line is accepted
  assertEquals(
    appendChunkCmd("/tmp/s.b64", "QUJDPT0="),
    "printf '%s\\n' 'QUJDPT0=' >> '/tmp/s.b64'",
  );
});
