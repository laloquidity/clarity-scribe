import CoreML
import Foundation

// Parakeet TDT 0.6B v3 ASR sidecar.
//
// Newline-delimited JSON protocol on stdin/stdout, one request per line:
//   request:  {"id":"<string>","audioPath":"<path to raw f32le mono 16kHz>"}
//   response: {"id":"<string>","text":"<transcript>","tokens":[...],
//              "ms":{"mel":N,"encoder":N,"decode":N,"total":N}}
//   health:   {"cmd":"ready"} -> {"ready":true}
// On EOF: exit cleanly.
//
// stderr is used for human-readable log lines; stdout carries only JSON responses.

// MARK: - IO helpers

let stdoutLock = NSLock()

func writeLine(_ json: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]) else {
        return
    }
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))  // newline
}

func logError(_ message: String) {
    FileHandle.standardError.write(Data(("[parakeet-sidecar] " + message + "\n").utf8))
}

func errorResponse(id: String?, message: String) {
    var resp: [String: Any] = ["error": message]
    if let id = id { resp["id"] = id }
    writeLine(resp)
}

/// Read raw little-endian float32 samples from a file.
func readF32(_ path: String) throws -> [Float] {
    let url = URL(fileURLWithPath: path)
    let data = try Data(contentsOf: url)
    guard data.count % 4 == 0 else {
        throw SidecarError.io("Audio file size \(data.count) is not a multiple of 4 bytes")
    }
    let count = data.count / 4
    var samples = [Float](repeating: 0, count: count)
    samples.withUnsafeMutableBytes { dst in
        data.copyBytes(to: dst, count: data.count)
    }
    return samples
}

// MARK: - Startup

let modelDir = ParakeetModels.resolveModelDir()
logError("Loading models from \(modelDir.path) ...")

let pipeline: Pipeline
do {
    let loadStart = Date()
    let models = try ParakeetModels.load(from: modelDir)
    pipeline = try Pipeline(models: models)
    let loadMs = Int(Date().timeIntervalSince(loadStart) * 1000)
    logError("Models loaded in \(loadMs) ms (vocab: \(models.vocabulary.count) tokens)")

    let warmStart = Date()
    try pipeline.warmup()
    let warmMs = Int(Date().timeIntervalSince(warmStart) * 1000)
    logError("Warmup pass complete in \(warmMs) ms; ready.")
} catch {
    logError("FATAL: failed to load models: \(error)")
    errorResponse(id: nil, message: "model load failed: \(error)")
    exit(1)
}

// MARK: - Request loop

@MainActor
func handle(line: String) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    guard let data = trimmed.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        errorResponse(id: nil, message: "invalid JSON request")
        return
    }

    // Health / warmup command.
    if let cmd = obj["cmd"] as? String {
        if cmd == "ready" {
            writeLine(["ready": true])
        } else {
            errorResponse(id: obj["id"] as? String, message: "unknown cmd: \(cmd)")
        }
        return
    }

    let id = obj["id"] as? String
    guard let audioPath = obj["audioPath"] as? String else {
        errorResponse(id: id, message: "missing audioPath")
        return
    }

    do {
        let samples = try readF32(audioPath)
        let (text, tokens, timings) = try pipeline.transcribe(samples: samples)
        let response: [String: Any] = [
            "id": id ?? "",
            "text": text,
            "tokens": tokens,
            "ms": [
                "mel": Int(timings.mel.rounded()),
                "encoder": Int(timings.encoder.rounded()),
                "decode": Int(timings.decode.rounded()),
                "total": Int(timings.total.rounded()),
            ],
        ]
        writeLine(response)
    } catch {
        errorResponse(id: id, message: "\(error)")
    }
}

while let line = readLine(strippingNewline: true) {
    handle(line: line)
}
// EOF -> clean exit.
logError("stdin closed; exiting.")
exit(0)
