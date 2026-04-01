# CUDA OnnxRuntime Build — Agent Handoff Document

## Project Summary

**App**: Clarity Scribe — an Electron + React desktop app that transcribes audio using two backends:
- **Whisper** (`smart-whisper` npm package, custom `whisper.cpp` build, already has CUDA/Vulkan working on Windows)
- **Parakeet TDT** (`onnxruntime-node` npm package, currently uses DirectML on Windows)

**Goal**: Build `onnxruntime-node` from source with CUDA support on Windows so Parakeet TDT uses the RTX 3090 GPU directly via CUDA instead of DirectML.

**Repo**: `c:\Users\Hilal\Downloads\clarity-scribe`

---

## Current Build Status (as of handoff)

### ✅ What is DONE / SOLVED

A build is **actively running right now** (Background Command ID: `9a87fbde-c9a1-48b1-8a51-e05d214eff2b`). Check its status first thing.

The following problems have ALL been solved:

| Problem | Fix Applied |
|---|---|
| CMake 4.2.3 doesn't find VS 2022 generator | Use CMake 3.31.6 at `C:\cmake-portable\cmake\data\bin\cmake.exe` |
| VS 2022 missing C++ workload | User installed it — verified working |
| cuDNN 9.20 uses versioned subdirectories | Pass `CUDNN_INCLUDE_DIR=C:/Program Files/NVIDIA/CUDNN/v9.20/include/13.2` and `CMAKE_LIBRARY_PATH=C:/Program Files/NVIDIA/CUDNN/v9.20/lib/13.2/x64` |
| CUDA 13+ defaults to Clang frontend (no Clang installed) | Pass `CMAKE_CUDA_COMPILER_FRONTEND_VARIANT=MSVC` |
| CUDA 13.2 dropped compute_60 and compute_70 | Pass `CMAKE_CUDA_ARCHITECTURES=75;80;86;89;90;100;120` (confirmed valid via `nvcc --list-gpu-arch`) |
| CUDA 13.2 CCCL headers require new MSVC preprocessor | Pass `CMAKE_CUDA_FLAGS=-Xcompiler /Zc:preprocessor` |
| SSL cert revocation check fails after restart | Pass env var `CMAKE_TLS_VERIFY=0` |

**Evidence of success in the last build (log17/18):**
- CMake config completed: `-- Configuring done (554.9s)`
- cuDNN found: `-- cudnn found at C:/Program Files/NVIDIA/CUDNN/v9.20/lib/13.2/x64/cudnn.lib.`
- CUDA compiler passed: `-- The CUDA compiler identification is NVIDIA 13.2.51 with host compiler MSVC 19.39.33520.0`
- CUDA architectures set: `CMAKE_CUDA_ARCHITECTURES: 75-real;80-real;86-real;89-real;90a-real;100a-real;120a-real`
- All static libs compiled: `onnxruntime_providers.lib` at 248MB (includes CUDA provider code)
- `onnxruntime.dll` built at `C:\ort-build\build\Windows\Release\Release\onnxruntime.dll`
- Node.js cmake-js linking was in progress when the last check happened

### ⚠️ Known Remaining Issue (may or may not have caused the current run to fail)

In build_log17 (previous run), two errors appeared during CUDA kernel compilation that caused some `.cu` files to fail:

1. `error C2220: the following warning is treated as an error` — from `non_max_suppression_impl.cu` and a few others. This is a `__nv_fp8_e4m3` stub file triggering a conversion warning upgraded to error in some targets.
2. These caused `onnxruntime_providers_cuda.dll` to NOT be linked in the previous run.

**The current run (build_log18) may succeed** because:
- All CUDA `.cu` objects that succeeded are cached (MSBuild incremental build)
- The node_modules EPERM issue was fixed by deleting before restart
- cmake-js was observed running in the last status check

---

## What To Do First: Check Build Result

```powershell
# 1. Check if the build completed
Get-ChildItem "C:\ort-build\build\Windows\Release\Release" -Filter "*.dll" | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}}

# 2. Check if onnxruntime.node was built (the Node.js addon)
Get-ChildItem "C:\ort-build\js\node" -Recurse -Filter "onnxruntime.node" -Depth 5 | Select-Object FullName
```

**If `onnxruntime_providers_cuda.dll` exists AND `onnxruntime.node` exists → BUILD SUCCEEDED. Skip to "Next Steps: Integration".**

**If build failed** → see "Recovery Plan" below.

---

## Recovery Plan (If Current Build Failed)

### If `onnxruntime_providers_cuda.dll` is missing but `onnxruntime_providers.lib` exists (248MB):

The CUDA code compiled but the DLL wasn't linked. The `C2220` warning-as-error is the likely cause. Fix: add `/WX-` to suppress warnings-as-errors for CUDA host compilation:

```powershell
$env:CMAKE_TLS_VERIFY = "0"
cd C:\ort-build
python tools/ci_build/build.py `
  --cmake_path "C:\cmake-portable\cmake\data\bin\cmake.exe" `
  --build_dir build/Windows --config Release `
  --build_shared_lib --use_cuda `
  --cuda_home "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2" `
  --cudnn_home "C:\Program Files\NVIDIA\CUDNN\v9.20" `
  --build_nodejs --skip_tests --parallel `
  --cmake_extra_defines `
    "CUDNN_INCLUDE_DIR=C:/Program Files/NVIDIA/CUDNN/v9.20/include/13.2" `
    "CMAKE_LIBRARY_PATH=C:/Program Files/NVIDIA/CUDNN/v9.20/lib/13.2/x64" `
    "CMAKE_CUDA_COMPILER_FRONTEND_VARIANT=MSVC" `
    "CMAKE_CUDA_ARCHITECTURES=75;80;86;89;90;100;120" `
    "CMAKE_CUDA_FLAGS=-Xcompiler /Zc:preprocessor" `
  --build 2>&1 | Tee-Object -FilePath C:\ort-build\build_log19.txt
```

Note: `--build` skips the CMake configure step (reuses existing build dir). Only use `--build` if `C:\ort-build\build\Windows\Release` already exists with a valid configuration.

### If you need a full clean restart:
Remove `--build` flag and add `--clean` first, or delete `C:\ort-build\build\Windows` manually before running.

### The definitive full command (use this for any fresh start):
```powershell
Remove-Item -Recurse -Force "C:\ort-build\build\Windows" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "C:\ort-build\js\node\node_modules" -ErrorAction SilentlyContinue
$env:CMAKE_TLS_VERIFY = "0"
cd C:\ort-build
python tools/ci_build/build.py `
  --cmake_path "C:\cmake-portable\cmake\data\bin\cmake.exe" `
  --build_dir build/Windows --config Release `
  --build_shared_lib --use_cuda `
  --cuda_home "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2" `
  --cudnn_home "C:\Program Files\NVIDIA\CUDNN\v9.20" `
  --build_nodejs --skip_tests --parallel `
  --cmake_extra_defines `
    "CUDNN_INCLUDE_DIR=C:/Program Files/NVIDIA/CUDNN/v9.20/include/13.2" `
    "CMAKE_LIBRARY_PATH=C:/Program Files/NVIDIA/CUDNN/v9.20/lib/13.2/x64" `
    "CMAKE_CUDA_COMPILER_FRONTEND_VARIANT=MSVC" `
    "CMAKE_CUDA_ARCHITECTURES=75;80;86;89;90;100;120" `
    "CMAKE_CUDA_FLAGS=-Xcompiler /Zc:preprocessor" `
  2>&1 | Tee-Object -FilePath C:\ort-build\build_log_new.txt
```

---

## System Environment (Do Not Change)

| Component | Location / Version |
|---|---|
| ORT source | `C:\ort-build` (tag v1.24.3) |
| CUDA Toolkit | `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2` |
| cuDNN | `C:\Program Files\NVIDIA\CUDNN\v9.20` (versioned: `include\13.2\`, `lib\13.2\x64\`) |
| CMake 3.31.6 | `C:\cmake-portable\cmake\data\bin\cmake.exe` |
| Ninja | `C:\ninja-portable\bin\ninja.exe` (not needed, VS generator is used) |
| VS 2022 Community | `C:\Program Files\Microsoft Visual Studio\2022\Community` (C++ workload installed) |
| Python | `C:\Python311\python.exe` |
| GPU | NVIDIA RTX 3090 (compute_86) |

---

## Next Steps After Successful Build: Integration

When both files exist:
- `C:\ort-build\build\Windows\Release\Release\onnxruntime.dll`
- `C:\ort-build\build\Windows\Release\Release\onnxruntime_providers_cuda.dll`
- `C:\ort-build\build\Windows\Release\Release\onnxruntime_providers_shared.dll`
- `C:\ort-build\js\node\bin\napi-v6\win32\x64\onnxruntime.node` (the Node.js native addon)

### Step 1: Locate the built Node addon

```powershell
Get-ChildItem "C:\ort-build\js\node" -Recurse -Filter "onnxruntime.node" | Select-Object FullName
Get-ChildItem "C:\ort-build\js\node" -Recurse -Filter "*.dll" | Select-Object FullName
```

### Step 2: Swap into the app's node_modules

The app uses `onnxruntime-node` installed at:
`c:\Users\Hilal\Downloads\clarity-scribe\node_modules\onnxruntime-node\bin\napi-v6\win32\x64\`

Replace the files there:
```powershell
$dest = "c:\Users\Hilal\Downloads\clarity-scribe\node_modules\onnxruntime-node\bin\napi-v6\win32\x64"
$srcDll = "C:\ort-build\build\Windows\Release\Release"
$srcNode = # wherever onnxruntime.node was built

# Backup originals
Copy-Item "$dest\onnxruntime.dll" "$dest\onnxruntime.dll.dml_backup" -Force

# Copy the CUDA build
Copy-Item "$srcDll\onnxruntime.dll" "$dest\" -Force
Copy-Item "$srcDll\onnxruntime_providers_cuda.dll" "$dest\" -Force
Copy-Item "$srcDll\onnxruntime_providers_shared.dll" "$dest\" -Force
Copy-Item "$srcNode\onnxruntime.node" "$dest\" -Force
```

### Step 3: Add cuDNN DLLs to app resources

The cuDNN DLLs need to be available at runtime. Copy them to the app's win-gpu resources:
```powershell
$cudnnBin = "C:\Program Files\NVIDIA\CUDNN\v9.20\bin\13.2"
$appCuda = "c:\Users\Hilal\Downloads\clarity-scribe\resources\win-gpu\cuda"
New-Item -ItemType Directory -Force $appCuda
Get-ChildItem $cudnnBin -Filter "*.dll" | Copy-Item -Destination $appCuda
```

### Step 4: Update parakeetService.ts to use CUDA

File: `c:\Users\Hilal\Downloads\clarity-scribe\electron\parakeetService.ts`

Find `getExecutionProviders()` method (currently returns `['dml', 'cpu']` on Windows). Change to:
```typescript
private getExecutionProviders(): string[] {
  if (process.platform === 'win32') {
    return ['cuda', 'cpu'];  // Changed from ['dml', 'cpu']
  }
  // ... rest of platform checks
}
```

Also add cuDNN DLL path injection at session init (model the approach from `nativeWhisper.ts` `detectGpuBackend()` function which does dynamic DLL loading).

### Step 5: Update electron-builder.yml

File: `c:\Users\Hilal\Downloads\clarity-scribe\electron-builder.yml`

Add the new DLLs to the Windows extraFiles list (look at how Whisper's CUDA DLLs are already bundled there for reference — the pattern already exists in that file).

### Step 6: Test

```powershell
cd c:\Users\Hilal\Downloads\clarity-scribe
npm run dev
```

Check the console for: `cuda` execution provider being loaded (not `removing requested execution provider 'cuda'`).

---

## Key Files in Clarity Scribe

| File | Purpose |
|---|---|
| `electron/parakeetService.ts` | Parakeet TDT inference — change `getExecutionProviders()` here |
| `electron/nativeWhisper.ts` | Whisper inference — reference for CUDA DLL injection pattern |
| `electron-builder.yml` | Electron packager config — add DLLs to `extraFiles` |
| `electron/main.ts` | Main process — orchestrates service startup |

---

## Important Background Context

- The `onnxruntime-node` npm package ships with CPU+DirectML only on Windows by design (Microsoft decision). CUDA requires building from source.
- Whisper already works with CUDA on Windows via `smart-whisper` (separate custom `whisper.cpp` build).
- macOS uses CoreML/Metal — no changes needed there. This is Windows-only.
- The user is fine with a large installer (~900MB) to bundle cuDNN.
- DirectML is already working and fast. CUDA is a performance upgrade, not a bug fix.
