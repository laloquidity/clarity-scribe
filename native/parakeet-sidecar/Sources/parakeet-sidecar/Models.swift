import CoreML
import Foundation

/// Loads the 4 Parakeet CoreML models + vocabulary from a model directory.
///
/// Compute-unit assignment matches FluidInference/FluidAudio:
/// - Preprocessor (mel frontend): `.cpuOnly`
/// - Encoder / Decoder / Joint: `.cpuAndNeuralEngine`
struct ParakeetModels {
    let preprocessor: MLModel
    let encoder: MLModel
    let decoder: MLModel
    let joint: MLModel
    /// id -> token string (e.g. "▁the", "ing"). Blank id (8192) is absent.
    let vocabulary: [Int: String]

    static let defaultModelDir = "/tmp/coreml-models/parakeet-tdt-0.6b-v3"

    enum LoadError: Error, CustomStringConvertible {
        case missingFile(String)
        case vocabularyParse(String)

        var description: String {
            switch self {
            case .missingFile(let p): return "Required model file not found: \(p)"
            case .vocabularyParse(let m): return "Vocabulary parse failed: \(m)"
            }
        }
    }

    static func resolveModelDir() -> URL {
        let env = ProcessInfo.processInfo.environment["SCRIBE_PARAKEET_MODELS"]
        let path = (env?.isEmpty == false) ? env! : defaultModelDir
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    static func load(from directory: URL) throws -> ParakeetModels {
        func config(_ units: MLComputeUnits) -> MLModelConfiguration {
            let c = MLModelConfiguration()
            c.computeUnits = units
            // Matches FluidAudio defaultConfiguration(): allow fp16 accumulation.
            c.allowLowPrecisionAccumulationOnGPU = true
            return c
        }

        func loadModel(_ name: String, _ units: MLComputeUnits) throws -> MLModel {
            let url = directory.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw LoadError.missingFile(url.path)
            }
            return try MLModel(contentsOf: url, configuration: config(units))
        }

        // Preprocessor pinned to CPU to match FluidAudio; ANE for the rest.
        let preprocessor = try loadModel("Preprocessor.mlmodelc", .cpuOnly)
        let encoder = try loadModel("Encoder.mlmodelc", .cpuAndNeuralEngine)
        let decoder = try loadModel("Decoder.mlmodelc", .cpuAndNeuralEngine)
        let joint = try loadModel("JointDecision.mlmodelc", .cpuAndNeuralEngine)
        let vocabulary = try loadVocabulary(from: directory)

        return ParakeetModels(
            preprocessor: preprocessor,
            encoder: encoder,
            decoder: decoder,
            joint: joint,
            vocabulary: vocabulary
        )
    }

    private static func loadVocabulary(from directory: URL) throws -> [Int: String] {
        // Prefer parakeet_vocab.json, fall back to parakeet_v3_vocab.json.
        let candidates = ["parakeet_vocab.json", "parakeet_v3_vocab.json"]
        var vocabURL: URL?
        for name in candidates {
            let u = directory.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: u.path) {
                vocabURL = u
                break
            }
        }
        guard let url = vocabURL else {
            throw LoadError.missingFile(directory.appendingPathComponent(candidates[0]).path)
        }

        let data = try Data(contentsOf: url)
        let json = try JSONSerialization.jsonObject(with: data)

        var vocabulary: [Int: String] = [:]
        if let dict = json as? [String: String] {
            // 0.6B v2/v3 format: { "<id>": "<token>" }
            for (key, value) in dict {
                if let id = Int(key) { vocabulary[id] = value }
            }
        } else if let arr = json as? [String] {
            for (index, token) in arr.enumerated() { vocabulary[index] = token }
        } else {
            throw LoadError.vocabularyParse("unexpected JSON shape")
        }
        return vocabulary
    }
}
