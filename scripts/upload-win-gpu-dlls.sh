#!/usr/bin/env bash
#
# Mirror the Windows GPU backend DLLs (Whisper engine) on this repo's GitHub
# releases, so a from-source install can download them on demand — the same way
# the ONNX/CoreML models are hosted. These DLLs are gitignored (570 MB of CUDA
# libs is too large for git).
#
# The runtime downloader (scripts/download-win-gpu.js) fetches:
#   https://github.com/laloquidity/clarity-scribe/releases/download/win-gpu-dlls/win-gpu-vulkan.tar.gz
#   https://github.com/laloquidity/clarity-scribe/releases/download/win-gpu-dlls/win-gpu-cuda.tar.gz
#
# Usage:   ./scripts/upload-win-gpu-dlls.sh
# Requires: gh (authenticated, write access) and tar. Run from a machine that has
# the DLLs populated in resources/win-gpu/{cuda,vulkan}/.
set -euo pipefail

TAG="win-gpu-dlls"
REPO="laloquidity/clarity-scribe"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GPU_DIR="$ROOT/resources/win-gpu"

pack_and_upload() {
  local backend="$1"; local tarball="win-gpu-${backend}.tar.gz"
  local src="$GPU_DIR/$backend"
  if [ ! -e "$src/whisper.dll" ]; then
    echo "Skipping $backend — $src/whisper.dll not found." >&2
    return 0
  fi
  echo "Packing $backend DLLs -> /tmp/$tarball ..."
  tar -czf "/tmp/$tarball" -C "$src" .
  echo "  size: $(du -h "/tmp/$tarball" | cut -f1)"
  echo "Uploading $tarball ..."
  gh release upload "$TAG" "/tmp/$tarball" --repo "$REPO" --clobber
  rm -f "/tmp/$tarball"
}

# Create the release if it does not exist yet.
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Creating release $TAG ..."
  gh release create "$TAG" --repo "$REPO" \
    --title "Windows GPU backend DLLs" \
    --notes "whisper.cpp GPU backend DLLs (CUDA + Vulkan) for the Whisper engine on Windows. Downloaded on demand by a from-source install; bundled directly in the packaged installer."
fi

pack_and_upload vulkan
pack_and_upload cuda
echo "Done: GPU DLL bundles uploaded to $REPO release '$TAG'."
