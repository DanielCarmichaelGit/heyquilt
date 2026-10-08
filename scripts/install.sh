#!/bin/sh
# Installs the Quilt command line on a Linux machine without a desktop (a server, a cloud
# machine, a container). It brings its own Node.js, so nothing else is needed:
#
#   curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh
#
# Run it again to update. QUILT_VERSION=0.3.11 picks a version; QUILT_HOME (default
# ~/.quilt/cli) says where it goes; QUILT_BIN where the `quilt` command is linked.
set -eu

repo="DanielCarmichaelGit/heyquilt"
say () { printf '%s\n' "$*" >&2; }
fail () { say "quilt install: $*"; exit 1; }

[ "$(uname -s)" = "Linux" ] || fail "this installs Quilt on Linux. On a Mac or Windows, get the app from https://heyquilt.com"
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "no build for $(uname -m) yet (there are x86_64 and arm64)" ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is needed"
command -v tar >/dev/null 2>&1 || fail "tar is needed"

if [ -n "${QUILT_VERSION:-}" ]; then
  url="https://github.com/$repo/releases/download/v${QUILT_VERSION#v}/quilt-cli-linux-$arch.tar.gz"
else
  url="https://github.com/$repo/releases/latest/download/quilt-cli-linux-$arch.tar.gz"
fi
url="${QUILT_DOWNLOAD:-$url}" # a build to install from instead (for testing)
home="${QUILT_HOME:-$HOME/.quilt/cli}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
say "Downloading Quilt for linux-$arch…"
curl -fsSL --retry 3 -o "$tmp/quilt.tar.gz" "$url" || fail "could not download $url"
tar -xzf "$tmp/quilt.tar.gz" -C "$tmp"
[ -x "$tmp/quilt/quilt" ] || fail "the download is not a Quilt build"

# Swap the new build in whole, so a running quilt never sees half of one.
mkdir -p "$(dirname "$home")"
rm -rf "$home.new" "$home.old"
mv "$tmp/quilt" "$home.new"
[ -e "$home" ] && mv "$home" "$home.old"
mv "$home.new" "$home"
rm -rf "$home.old"

# The command: /usr/local/bin when we may write there, else ~/.local/bin.
if [ -n "${QUILT_BIN:-}" ]; then bin="$QUILT_BIN"
elif [ -w /usr/local/bin ]; then bin=/usr/local/bin
else bin="$HOME/.local/bin"
fi
mkdir -p "$bin"
ln -sf "$home/quilt" "$bin/quilt"

say "Installed $("$home/quilt" --version) at $home"
case ":$PATH:" in
  *":$bin:"*) next=quilt ;;
  *) say "$bin is not on your PATH: add it, or run $bin/quilt"; next="$bin/quilt" ;;
esac
say "Next: $next login (a person), or $next agent join <agent invite link> --name <name> (an AI agent)"
