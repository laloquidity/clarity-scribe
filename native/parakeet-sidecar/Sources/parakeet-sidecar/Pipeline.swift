import CoreML
import Foundation

enum SidecarError: Error, CustomStringConvertible {
    case shape(String)
    case io(String)

    var description: String {
        switch self {
        case .shape(let m): return m
        case .io(let m): return m
        }
    }
}

/// Per-stage timings, in milliseconds.
struct StageTimings {
    var mel = 0.0
    var encoder = 0.0
    var decode = 0.0
    var total = 0.0
}

/// Full Parakeet TDT pipeline: audio f32 -> chunk -> mel -> encoder -> TDT
/// greedy decode -> detokenize. Mirrors FluidAudio's ChunkProcessor semantics.
final class Pipeline {
    private let models: ParakeetModels
    private let config: TdtConfig
    private let decoder: TdtDecoder
    private let predictionOptions = MLPredictionOptions()

    // Chunking constants (match FluidAudio ASRConstants / ChunkProcessor).
    private static let sampleRate = 16000
    private static let maxModelSamples = 240_000
    private static let samplesPerEncoderFrame = 1280
    private static let melHopSize = 160
    private static let overlapSeconds = 2.0

    init(models: ParakeetModels) throws {
        self.models = models
        self.config = TdtConfig()
        self.decoder = try TdtDecoder(
            config: config, decoderModel: models.decoder, jointModel: models.joint)
    }

    // MARK: - Chunk geometry (ported from ChunkProcessor)

    private var chunkSamples: Int {
        let maxActualChunk = Self.maxModelSamples - Self.samplesPerEncoderFrame
        let raw = max(maxActualChunk - Self.melHopSize, Self.samplesPerEncoderFrame)
        return raw / Self.samplesPerEncoderFrame * Self.samplesPerEncoderFrame
    }
    private var overlapSamples: Int {
        let requested = Int(Self.overlapSeconds * Double(Self.sampleRate))
        let capped = min(requested, chunkSamples / 2)
        return capped / Self.samplesPerEncoderFrame * Self.samplesPerEncoderFrame
    }
    private var strideSamples: Int {
        let raw = max(chunkSamples - overlapSamples, Self.samplesPerEncoderFrame)
        return raw / Self.samplesPerEncoderFrame * Self.samplesPerEncoderFrame
    }
    private var melContextSamples: Int { Self.samplesPerEncoderFrame }

    // MARK: - Public API

    /// Transcribe raw mono 16kHz float32 samples. Returns text, token ids, timings.
    func transcribe(samples: [Float]) throws -> (text: String, tokens: [Int], timings: StageTimings) {
        let totalStart = Date()
        var timings = StageTimings()

        guard !samples.isEmpty else {
            timings.total = Date().timeIntervalSince(totalStart) * 1000
            return ("", [], timings)
        }

        var chunkOutputs: [[ChunkTokenMerger.TokenWindow]] = []
        var chunkStart = 0
        var chunkIndex = 0
        let state = TdtDecoderState()
        let totalSamples = samples.count

        while chunkStart < totalSamples {
            let candidateEnd = chunkStart + chunkSamples
            let isLastChunk = candidateEnd >= totalSamples
            let chunkEnd = isLastChunk ? totalSamples : candidateEnd
            if chunkEnd <= chunkStart { break }

            state.reset()

            let contextSamples = chunkIndex > 0 ? melContextSamples : 0
            let contextStart = chunkStart - contextSamples
            let windowSamples = readSamples(
                from: samples, offset: contextStart, count: chunkEnd - contextStart)

            let actualAudioSamples = windowSamples.count - contextSamples
            let actualFrameCount = encoderFrames(from: actualAudioSamples)
            let globalFrameOffset = chunkStart / Self.samplesPerEncoderFrame
            let contextFrames = contextSamples / Self.samplesPerEncoderFrame

            let hypothesis = try runChunk(
                windowSamples: windowSamples,
                originalLength: windowSamples.count,
                actualAudioFrames: actualFrameCount,
                state: state,
                contextFrameAdjustment: contextFrames,
                isLastChunk: isLastChunk,
                globalFrameOffset: globalFrameOffset,
                timings: &timings)

            let window: [ChunkTokenMerger.TokenWindow] = zip(
                zip(hypothesis.tokens, hypothesis.timestamps), hypothesis.durations
            ).map { (token: $0.0.0, timestamp: $0.0.1, duration: $0.1) }
            chunkOutputs.append(window)

            chunkIndex += 1
            if isLastChunk { break }
            chunkStart += strideSamples
        }

        var merged = chunkOutputs.first ?? []
        if chunkOutputs.count > 1 {
            for chunk in chunkOutputs.dropFirst() {
                merged = ChunkTokenMerger.mergePair(merged, chunk, overlapSeconds: Self.overlapSeconds)
            }
        }
        if merged.count > 1 {
            merged.sort { $0.timestamp < $1.timestamp }
        }

        let tokens = merged.map { $0.token }
        let text = detokenize(tokens)
        timings.total = Date().timeIntervalSince(totalStart) * 1000
        return (text, tokens, timings)
    }

    // MARK: - Single chunk inference

    private func runChunk(
        windowSamples: [Float],
        originalLength: Int,
        actualAudioFrames: Int,
        state: TdtDecoderState,
        contextFrameAdjustment: Int,
        isLastChunk: Bool,
        globalFrameOffset: Int,
        timings: inout StageTimings
    ) throws -> TdtHypothesis {
        // Pad to model length.
        let padded = padAudio(windowSamples, targetLength: Self.maxModelSamples)

        // --- Preprocessor (CPU) ---
        let melStart = Date()
        let audioArray = try ANEMemory.makeAlignedArray(
            shape: [1, NSNumber(value: padded.count)], dataType: .float32)
        padded.withUnsafeBufferPointer { buf in
            let dst = audioArray.dataPointer.bindMemory(to: Float.self, capacity: padded.count)
            dst.update(from: buf.baseAddress!, count: padded.count)
        }
        let audioLength = try MLMultiArray(shape: [1], dataType: .int32)
        audioLength[0] = NSNumber(value: originalLength)

        let preInput = try MLDictionaryFeatureProvider(dictionary: [
            "audio_signal": MLFeatureValue(multiArray: audioArray),
            "audio_length": MLFeatureValue(multiArray: audioLength),
        ])
        let preOutput = try models.preprocessor.prediction(from: preInput, options: predictionOptions)
        timings.mel += Date().timeIntervalSince(melStart) * 1000

        guard let mel = preOutput.featureValue(for: "mel")?.multiArrayValue,
            let melLength = preOutput.featureValue(for: "mel_length")?.multiArrayValue
        else {
            throw SidecarError.shape("Preprocessor output missing mel/mel_length")
        }

        // --- Encoder (ANE) ---
        let encStart = Date()
        let encInput = try MLDictionaryFeatureProvider(dictionary: [
            "mel": MLFeatureValue(multiArray: mel),
            "mel_length": MLFeatureValue(multiArray: melLength),
        ])
        let encOutput = try models.encoder.prediction(from: encInput, options: predictionOptions)
        timings.encoder += Date().timeIntervalSince(encStart) * 1000

        guard let encoder = encOutput.featureValue(for: "encoder")?.multiArrayValue,
            let encoderLength = encOutput.featureValue(for: "encoder_length")?.multiArrayValue
        else {
            throw SidecarError.shape("Encoder output missing encoder/encoder_length")
        }
        let encoderSequenceLength = encoderLength[0].intValue

        // --- TDT greedy decode (Decoder + JointDecision, ANE) ---
        let decStart = Date()
        let hypothesis = try decoder.decode(
            encoderOutput: encoder,
            encoderSequenceLength: encoderSequenceLength,
            actualAudioFrames: actualAudioFrames,
            state: state,
            contextFrameAdjustment: contextFrameAdjustment,
            isLastChunk: isLastChunk,
            globalFrameOffset: globalFrameOffset)
        timings.decode += Date().timeIntervalSince(decStart) * 1000

        return hypothesis
    }

    // MARK: - Helpers

    /// SentencePiece detokenize: concatenate token strings, ▁ -> space, trim.
    private func detokenize(_ tokens: [Int]) -> String {
        var pieces: [String] = []
        pieces.reserveCapacity(tokens.count)
        for id in tokens {
            if let s = models.vocabulary[id], !s.isEmpty { pieces.append(s) }
        }
        return pieces.joined()
            .replacingOccurrences(of: "\u{2581}", with: " ")
            .trimmingCharacters(in: .whitespaces)
    }

    private func encoderFrames(from samples: Int) -> Int {
        Int(ceil(Double(samples) / Double(Self.samplesPerEncoderFrame)))
    }

    private func padAudio(_ samples: [Float], targetLength: Int) -> [Float] {
        if samples.count >= targetLength { return Array(samples.prefix(targetLength)) }
        var out = samples
        out.append(contentsOf: repeatElement(0, count: targetLength - samples.count))
        return out
    }

    /// Read `count` samples starting at `offset`, zero-padding any out-of-range
    /// region (offset may be negative for prepended context).
    private func readSamples(from samples: [Float], offset: Int, count: Int) -> [Float] {
        var out = [Float](repeating: 0, count: count)
        let total = samples.count
        for i in 0..<count {
            let srcIdx = offset + i
            if srcIdx >= 0 && srcIdx < total { out[i] = samples[srcIdx] }
        }
        return out
    }

    /// Warmup: run one forward pass on silence so the first real request is fast.
    func warmup() throws {
        let silence = [Float](repeating: 0, count: Self.maxModelSamples)
        var timings = StageTimings()
        let state = TdtDecoderState()
        _ = try? runChunk(
            windowSamples: silence,
            originalLength: silence.count,
            actualAudioFrames: encoderFrames(from: silence.count),
            state: state,
            contextFrameAdjustment: 0,
            isLastChunk: true,
            globalFrameOffset: 0,
            timings: &timings)
    }
}
