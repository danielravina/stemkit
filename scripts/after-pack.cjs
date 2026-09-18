const { chmodSync, renameSync, writeFileSync, existsSync } = require('fs')
const { join } = require('path')

/* Chromium boots its zygote before any app JS runs, so `no-sandbox` must be
   decided before the executable starts (Electron reads it from argv or from
   the ELECTRON_DISABLE_SANDBOX env var in BasicStartupComplete, see
   shell/app/electron_main_delegate.cc). AppRun execs the packed executable
   directly with no hook of its own, so on Linux we swap it for a launcher
   that makes that decision for Electron: keep the sandbox when the kernel
   can still provide one (unprivileged user namespaces, or a properly
   installed root-owned SUID chrome-sandbox — e.g. the deb target), and set
   ELECTRON_DISABLE_SANDBOX otherwise (e.g. the AppImage target on Ubuntu
   24.04+, where AppArmor blocks unprivileged user namespaces and the
   read-only FUSE mount can never satisfy the SUID check — issue #15). */

function launcherScript(bin) {
  return `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/${bin}.bin"

if (command -v unshare >/dev/null 2>&1 && unshare -Ur true 2>/dev/null) \\
   || { sb="$DIR/chrome-sandbox"; [ -e "$sb" ] \\
        && [ "$(stat -c '%u %a' "$sb" 2>/dev/null)" = "0 4755" ]; }; then
  exec "$BIN" "$@"
fi

export ELECTRON_DISABLE_SANDBOX=1
exec "$BIN" "$@"
`
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return

  const dir = context.appOutDir
  const bin = context.packager.executableName

  // deb/rpm installs unpack as root, so the SUID sandbox works — make sure
  // the helper carries the bit no matter how the electron zip was unpacked
  const chromeSandbox = join(dir, 'chrome-sandbox')
  if (existsSync(chromeSandbox)) chmodSync(chromeSandbox, 0o4755)

  renameSync(join(dir, bin), join(dir, `${bin}.bin`))
  writeFileSync(join(dir, bin), launcherScript(bin), { mode: 0o755 })
}