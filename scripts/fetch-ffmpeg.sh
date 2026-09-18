#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"
mkdir -p "$ROOT/extras"

if [[ "$OS" == "Darwin" ]]; then
  OUT="$ROOT/extras/ffmpeg-mac"
  if [[ -x "$OUT/ffmpeg" ]]; then
    echo "ffmpeg already present: $OUT/ffmpeg"
    "$OUT/ffmpeg" -version | head -1
    exit 0
  fi
  mkdir -p "$OUT"
  echo "downloading static ffmpeg for macOS..."
  curl -fsSL -o "$ROOT/extras/ffmpeg-mac.zip" "https://evermeet.cx/ffmpeg/get/ffmpeg/zip"
  unzip -oq "$ROOT/extras/ffmpeg-mac.zip" -d "$OUT"
  rm -f "$ROOT/extras/ffmpeg-mac.zip"
  chmod +x "$OUT/ffmpeg"
  "$OUT/ffmpeg" -version | head -1
  echo "saved to $OUT/ffmpeg"
elif [[ "$OS" == "Linux" ]]; then
  OUT="$ROOT/extras/ffmpeg-linux"
  if [[ -x "$OUT/ffmpeg" ]]; then
    echo "ffmpeg already present: $OUT/ffmpeg"
    "$OUT/ffmpeg" -version | head -1
    exit 0
  fi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) JV_ARCH="amd64" ;;
    aarch64|arm64) JV_ARCH="arm64" ;;
    *)
      echo "unsupported Linux arch: $ARCH (need x86_64 or aarch64)"
      exit 1
      ;;
  esac
  mkdir -p "$OUT"
  echo "downloading static ffmpeg for Linux ($JV_ARCH)..."
  TMP_TXZ="$ROOT/extras/ffmpeg-linux.tar.xz"
  TMP_DIR="$ROOT/extras/ffmpeg-linux-extract"
  # primary: johnvansickle (broadest glibc compatibility). fallback: BtbN git
  # builds hosted on GitHub — johnvansickle is a personal server that
  # rate-limits/stalls under CI load, which once shipped an HTML error page
  # where the tarball should be (xz: File format not recognized)
  if [[ "$JV_ARCH" == "amd64" ]]; then
    URLS=(
      "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
      "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz"
    )
  else
    URLS=(
      "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
      "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
    )
  fi
  for url in "${URLS[@]}"; do
    echo "trying $url ..."
    rm -f "$TMP_TXZ"
    # --max-time: a stalled host must fail over, not hang the CI job
    if ! curl -fsSL --max-time 180 --retry 2 -o "$TMP_TXZ" "$url"; then
      echo "download failed from $url"
      continue
    fi
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"
    if tar -xJf "$TMP_TXZ" -C "$TMP_DIR" 2>/dev/null; then
      echo "extracted ok from $url"
      break
    fi
    echo "archive from $url is not a valid xz tarball"
  done
  BIN="$(find "$TMP_DIR" -name ffmpeg -type f | head -1)"
  if [[ -z "$BIN" ]]; then
    echo "ffmpeg binary not found inside archive"
    exit 1
  fi
  cp -f "$BIN" "$OUT/ffmpeg"
  rm -rf "$TMP_DIR" "$TMP_TXZ"
  chmod +x "$OUT/ffmpeg"
  "$OUT/ffmpeg" -version | head -1
  echo "saved to $OUT/ffmpeg"
elif [[ "$OS" == "MINGW"* || "$OS" == "MSYS"* || "$OS" == "CYGWIN"* ]]; then
  echo "on Windows, run instead: powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1"
  exit 1
else
  echo "unsupported OS: $OS"
  exit 1
fi
