# Rebuild smart-whisper with CUDA BYOL
# Prerequisites: Download these two files to C:\Temp\electron-headers\
#   https://artifacts.electronjs.org/headers/dist/v39.8.3/node-v39.8.3-headers.tar.gz
#   https://artifacts.electronjs.org/headers/dist/v39.8.3/win-x64/node.lib

$ErrorActionPreference = "Stop"
$headersDir = "C:\Temp\electron-headers"
$projectRoot = Split-Path -Parent $PSScriptRoot

# Verify files exist
if (-not (Test-Path "$headersDir\node-v39.8.3-headers.tar.gz")) {
    Write-Error "Missing: $headersDir\node-v39.8.3-headers.tar.gz"
    exit 1
}
if (-not (Test-Path "$headersDir\node.lib")) {
    Write-Error "Missing: $headersDir\node.lib"
    exit 1
}

Write-Host "=== Step 1: Setting up Electron header cache ===" -ForegroundColor Cyan
$cachePath = "$env:USERPROFILE\.electron-gyp\39.8.3"
New-Item -ItemType Directory -Force -Path "$cachePath\win-x64" | Out-Null

# Extract headers
tar -xzf "$headersDir\node-v39.8.3-headers.tar.gz" -C "$cachePath" --strip-components=1
Copy-Item "$headersDir\node.lib" "$cachePath\win-x64\node.lib" -Force
Write-Host "Headers cached at: $cachePath" -ForegroundColor Green

Write-Host "`n=== Step 2: Rebuilding smart-whisper with CUDA BYOL ===" -ForegroundColor Cyan
$env:BYOL = "$projectRoot\resources\win-gpu\cuda\whisper.dll"
$env:HOME = "$env:USERPROFILE\.electron-gyp"
$env:npm_config_runtime = "electron"
$env:npm_config_target = "39.8.3"
$env:npm_config_disturl = "https://artifacts.electronjs.org/headers/dist"
$env:npm_config_devdir = "$env:USERPROFILE\.electron-gyp"

Write-Host "BYOL = $env:BYOL"
Set-Location $projectRoot
npx @electron/rebuild -f -o smart-whisper --verbose

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n=== SUCCESS ===" -ForegroundColor Green
    Write-Host "smart-whisper rebuilt with CUDA. Run 'npm run dev' to test."
} else {
    Write-Host "`n=== FAILED ===" -ForegroundColor Red
    exit 1
}
