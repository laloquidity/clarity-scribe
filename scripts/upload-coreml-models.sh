#!/usr/bin/env bash
#
# Mirror the Parakeet TDT 0.6B v3 CoreML model bundle on this repo's GitHub
# releases, so Scribe can download it on Apple Silicon as the default engine.
#
# The CoreML models originate from HuggingFace FluidInference/parakeet-tdt-0.6b-v3-coreml
# (Apache-2.0). We mirror them on our own releases for reliability/control, the
# same way the ONNX models are hosted.
#
# Usage:
#   ./scripts/upload-coreml-models.sh [SRC_DIR]
#
# Requires: gh (GitHub CLI, authenticated with write access) and tar.
# Run once, or whenever the model bundle changes.
#
# The runtime downloader (electron/parakeetSidecar.ts) fetches:
#   https://github.com/laloquidity/clarity-scribe/releases/download/parakeet-coreml-models/parakeet-tdt-0.6b-v3-coreml.tar.gz
set -euo pipefail

SRC="${1:-/tmp/coreml-models/parakeet-tdt-0.6b-v3}"
TAG="parakeet-coreml-models"
TARBALL="parakeet-tdt-0.6b-v3-coreml.tar.gz"
REPO="laloquidity/clarity-scribe"

if [ ! -d "$SRC" ]; then
  echo "Source model dir not found: $SRC" >&2
  echo "Download it first (HF FluidInference/parakeet-tdt-0.6b-v3-coreml: Preprocessor/Encoder/Decoder/JointDecision .mlmodelc + parakeet_vocab.json)." >&2
  exit 1
fi

# Sanity-check the required files are present before packing.
for f in Preprocessor.mlmodelc Encoder.mlmodelc Decoder.mlmodelc JointDecision.mlmodelc parakeet_vocab.json; do
  [ -e "$SRC/$f" ] || { echo "Missing required model file: $SRC/$f" >&2; exit 1; }
done

echo "Packing contents of $SRC -> /tmp/$TARBALL ..."
tar -czf "/tmp/$TARBALL" -C "$SRC" .
echo "Tarball size: $(du -h "/tmp/$TARBALL" | cut -f1)"

# Create the release if it does not exist yet, then upload (clobber existing asset).
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Creating release $TAG ..."
  gh release create "$TAG" --repo "$REPO" \
    --title "Parakeet v3 CoreML models" \
    --notes "CoreML .mlmodelc bundle for the Apple Neural Engine Parakeet engine. Source: HF FluidInference/parakeet-tdt-0.6b-v3-coreml (Apache-2.0)."
fi

echo "Uploading $TARBALL ..."
gh release upload "$TAG" "/tmp/$TARBALL" --repo "$REPO" --clobber
echo "Done: $TARBALL uploaded to $REPO release '$TAG'."
