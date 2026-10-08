// Which app download to offer. Browsers on Apple silicon still say "Intel Mac",
// so Macs get the Apple silicon build with the Intel one offered next to it.
const RELEASE = 'https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download'

export const DOWNLOADS = {
  macArm: { os: 'mac', label: 'Download for Mac', fine: 'Mac', href: `${RELEASE}/quilt-mac-arm64.dmg` },
  macIntel: { os: 'mac', label: 'Mac with Intel', fine: 'Intel Mac', href: `${RELEASE}/quilt-mac-x64.dmg` },
  windows: { os: 'windows', label: 'Download for Windows', fine: 'Windows', href: `${RELEASE}/quilt-windows-x64.exe` },
  linux: { os: 'linux', label: 'Download for Linux', fine: 'Linux', href: `${RELEASE}/quilt-linux-x86_64.AppImage` },
  linuxArm: { os: 'linux', label: 'Linux on ARM', fine: 'Linux (ARM)', href: `${RELEASE}/quilt-linux-arm64.AppImage` }
}

/** For a Linux server or cloud machine with no desktop: the command line, Node included. */
export const LINUX_CLI_INSTALL = 'curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh'

export function downloadFor (userAgent = '') {
  if (/Macintosh|Mac OS X/.test(userAgent)) return DOWNLOADS.macArm
  if (/Windows/.test(userAgent)) return DOWNLOADS.windows
  if (/Linux/.test(userAgent) && !/Android/.test(userAgent)) return DOWNLOADS.linux
  return null
}

// The fuller pick used by the landing page's client-side download buttons: which button(s) to
// show as the primary call to action, and which builds belong in the fine print underneath.
// `platform`/`architecture` come from navigator.userAgentData.getHighEntropyValues(); `ua` is a
// fallback user-agent string for when high-entropy values aren't available (e.g. the server).
export function pickDownloads ({ platform = '', architecture = '', ua = '' } = {}) {
  const p = String(platform).toLowerCase()
  const arch = String(architecture).toLowerCase()
  // Phones say "like Mac OS X" (iPhone) or "Linux" (Android): there's no app for them, so both.
  const phone = /iPhone|iPad|iPod|Android/.test(ua)
  const isMac = !phone && (p.includes('mac') || (!p && /Macintosh|Mac OS X/.test(ua)))
  const isWin = !phone && (p.includes('win') || (!p && /Windows/.test(ua)))
  const isLinux = !phone && !isMac && !isWin && (p.includes('linux') || (!p && /Linux|X11/.test(ua)))

  if (isMac) {
    // Browsers report "Intel" even on Apple silicon; only trust an explicit "x86" architecture.
    const isArm = arch !== 'x86'
    const primary = isArm ? DOWNLOADS.macArm : { ...DOWNLOADS.macIntel, label: 'Download for Mac' }
    const otherMac = isArm ? DOWNLOADS.macIntel : DOWNLOADS.macArm
    return { primary: [primary], others: [otherMac, DOWNLOADS.windows] }
  }
  if (isWin) return { primary: [DOWNLOADS.windows], others: [DOWNLOADS.macArm, DOWNLOADS.linux] }
  if (isLinux) {
    const isArm = /arm/.test(arch) || (!arch && /aarch64|arm64/i.test(ua))
    return { primary: [isArm ? DOWNLOADS.linuxArm : DOWNLOADS.linux], others: [isArm ? DOWNLOADS.linux : DOWNLOADS.linuxArm, DOWNLOADS.macArm, DOWNLOADS.windows] }
  }
  // Can't tell (Safari, mobile, or detection failed): offer both.
  return { primary: [DOWNLOADS.macArm, DOWNLOADS.windows], others: [DOWNLOADS.macIntel, DOWNLOADS.linux] }
}

// The pick for this browser, worked out client-side so pages that show download buttons can
// stay static. Uses navigator.userAgentData's high-entropy values where the browser has them
// (Chromium: tells Apple silicon from Intel), else the user-agent string, else both buttons.
export async function detectDownloads (nav) {
  if (!nav) return pickDownloads({})
  const ua = String(nav.userAgent || '')
  const uad = nav.userAgentData
  if (uad && typeof uad.getHighEntropyValues === 'function') {
    try {
      const { architecture, platform } = await uad.getHighEntropyValues(['architecture', 'platform'])
      return pickDownloads({ architecture, platform, ua })
    } catch {} // fall through to the user-agent string
  }
  return pickDownloads({ ua })
}
