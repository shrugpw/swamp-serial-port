# @shrug/serial-port

Do actions over a USB-UART serial line from swamp. A model type for driving a
device on a serial console — a single-board computer on `/dev/ttyUSB0`, a router
console, a microcontroller — by configuring the port, sending commands, and
capturing the responses as structured swamp resources. The protocol logic
(idle-based capture, shell-prompt detection, getty login sequencing) is written
against an abstract port + injectable clock, so it is fully unit-tested with **no
hardware attached**; only the transport layer touches the OS.

## Methods

| method | what it does |
|--------|--------------|
| `establish` | Validate + configure the port (baud/framing/raw via `stty`), probe it, and record the `port` resource that later calls inherit config from. Fails loudly if the port is held by another process. |
| `send` | Write one line (or raw bytes) to the port. |
| `read` | Drain inbound bytes until the line goes idle or a cap is hit. |
| `exec` | Send a command line and capture the response until the shell prompt returns or the line goes idle. The console-shell primitive. |
| `login` | Answer a getty login (`login:` / `Password:`) using a vaulted credential, then confirm the shell prompt. The password never lands in the recorded transcript. |

## Config (global arguments)

| arg | default | notes |
|-----|---------|-------|
| `device` | `/dev/ttyUSB0` | Allowlisted to real serial tty paths (`/dev/ttyUSB*`, `/dev/ttyACM*`, `/dev/ttyS*`, `/dev/serial/*`). |
| `baud` | `115200` | |
| `framing` | `8N1` | data/parity/stop, e.g. `8N1`, `7E1`. |
| `lineEnding` | `\n` | use `\r` for consoles that need carriage return. |
| `transport` | `auto` | `direct` (raw `Deno.open` fd), `subprocess` (`dd`/`cat`, needs only `--allow-run`), or `auto` (direct with subprocess fallback on a device-open permission denial). |
| `username` | — | default username for `login`. |
| `password` | — | sensitive; a vault reference, never a literal. Used by `login`. |

## Usage

```sh
swamp model create @shrug/serial-port my-board
# defaults are /dev/ttyUSB0, 115200, 8N1, transport=auto

swamp model method run my-board establish
swamp model method run my-board exec --input command='uname -a' --input 'prompt=\]\$ $'
swamp model method run my-board read --input idleMs=1000
```

Read results back from the recorded resources with CEL, e.g. wire the captured
output of one step into the next in a workflow:

```yaml
inputs:
  banner: ${{ data.latest("my-board", "execResult").attributes.output }}
```

## How it works

Deno has no native termios/serial API, and native npm serial modules do not
survive swamp's bundler, so line configuration always shells out to `stty(1)`.
Byte I/O runs over one of two transports: a **direct** raw file descriptor
(`Deno.open`), or a **subprocess** transport that holds the port open with a
long-lived `cat` reader (streaming RX into a byte queue so nothing is dropped
between reads) and writes with `dd`. `auto` tries direct and falls back to
subprocess when the runtime denies an in-process device open — which is what
happens under a swamp build that scopes filesystem permissions.

**Safety:** `device` is constrained to real serial tty paths (with `.`/`..`
traversal rejected), so `login` cannot be steered into writing the vaulted
password to an arbitrary terminal. Stop-pattern regexes are matched only against
a bounded suffix of the output, and `idleMs`/`maxMs` carry ceilings, so a
caller-supplied prompt pattern can neither hang the event loop nor grow memory
without bound. Cross-instance exclusivity is a documented limitation: an external
holder (`screen`/`minicom`) is detected via `EBUSY`, but the model does not claim
a `TIOCEXCL` lock itself — operate one driver per device.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
