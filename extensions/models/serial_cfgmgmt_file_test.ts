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
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { type CommandResult, type Session } from "./serial_cfgmgmt_lib.ts";
import {
  appendChunkCmd,
  chunkBase64,
  extractBetweenMarkers,
  finalizeCmd,
  fromBase64,
  gunzipBytes,
  gzipBytes,
  pullViaSession,
  pushViaSession,
  resourceKey,
  sha256Hex,
  shq,
  stagingPathFor,
  toBase64,
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
  assertEquals(dec(fromBase64(wrapped + "\r\n  ")), "hello world, this is a config line");
});

Deno.test("chunkBase64 splits at the line ceiling, last chunk short", () => {
  const chunks = chunkBase64("abcdefgh", 3);
  assertEquals(chunks, ["abc", "def", "gh"]);
  assertEquals(chunkBase64("", 3), []);
});

Deno.test("gzip/gunzip round-trips (and gunzip reads our own gzip)", async () => {
  const data = enc("configuration=true\nrepeat repeat repeat repeat\n".repeat(20));
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
  assertEquals(extractBetweenMarkers(text, "__SWAMP_XFER_BEGIN__", "__SWAMP_XFER_END__"), "SGVsbG8=");
});

Deno.test("shq neutralizes embedded single quotes", () => {
  assertEquals(shq("/tmp/a'b"), "'/tmp/a'\\''b'");
  assertEquals(appendChunkCmd("/tmp/s.b64", "QUJD"), "printf '%s\\n' 'QUJD' >> '/tmp/s.b64'");
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

      if ((m = command.match(/^sha256sum '([^']+)'/))) {
        const f = fs.get(m[1]);
        if (!f) return { stdout: "", exitCode: 1 };
        return ok((await sha(f)) + "  " + m[1]);
      }

      if ((m = command.match(/^chmod '([^']+)' '([^']+)'/))) return ok();
      if ((m = command.match(/^chown '([^']+)' '([^']+)'/))) return ok();

      // pull: printf BEGIN; [gzip -c f |] base64 f; printf END
      if (command.includes("__SWAMP_XFER_BEGIN__")) {
        const pm = command.match(/(?:gzip -c|base64) '([^']+)'/);
        const path = pm?.[1] ?? "";
        const f = fs.get(path);
        if (!f) {
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

async function preparePush(session: Session, data: Uint8Array, gzip: boolean, extra: Partial<Parameters<typeof pushViaSession>[1]> = {}) {
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

Deno.test("push fails loudly and LEAVES staging on sha256 mismatch", async () => {
  const data = enc("important config");
  const t = fakeTarget({ tamperFinalize: (b) => new Uint8Array([...b, 33]) }); // flip content
  await assertRejects(
    () => preparePush(t, data, true),
    Error,
    "sha256 mismatch",
  );
  // staging file must remain for diagnosis (never rm'd after the failure)
  assertEquals(t.staging.size, 1);
});

Deno.test("push fails after exhausting retries on a persistently-failing chunk", async () => {
  const data = enc("x".repeat(1500));
  // corruptChunk with seen-once only fails once; simulate persistent failure via a session that always fails the append.
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
  const res = await pullViaSession(t, { remotePath: "/var/log/app.log", gzip: true });
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

Deno.test("pull throws on a missing/empty remote file", async () => {
  const t = fakeTarget();
  await assertRejects(
    () => pullViaSession(t, { remotePath: "/nope", gzip: true }),
    Error,
    "no data",
  );
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
  const bad = await verifyViaSession(t, { localSha: "00", remotePath: "/etc/x" });
  assertEquals(bad.match, false);
  assertEquals(bad.remoteSha, localSha);
});

Deno.test("verify reports no match when remote file is absent", async () => {
  const t = fakeTarget();
  assertEquals(await verifyViaSession(t, { localSha: "ab", remotePath: "/gone" }), {
    match: false,
    remoteSha: null,
  });
});

// ── command builders ─────────────────────────────────────────────────────────

Deno.test("finalizeCmd is gzip-aware and pipefail-guarded", () => {
  assertEquals(
    finalizeCmd("/tmp/s.b64", "/etc/app.conf", true),
    "set -o pipefail 2>/dev/null; base64 -d '/tmp/s.b64' | gzip -d > '/etc/app.conf'",
  );
  assertEquals(
    finalizeCmd("/tmp/s.b64", "/etc/app.conf", false),
    "set -o pipefail 2>/dev/null; base64 -d '/tmp/s.b64' > '/etc/app.conf'",
  );
});
