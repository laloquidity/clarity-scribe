import Accelerate
import CoreML
import Foundation

/// Token-and-Duration Transducer (TDT) greedy decoder.
///
/// Ported faithfully from FluidInference/FluidAudio
/// (Sources/FluidAudio/ASR/Parakeet/Decoder/TdtDecoderV3.swift), Apache-2.0.
///
/// The JointDecision CoreML model performs the token argmax and duration argmax
/// internally, emitting `token_id` (0..8192, where 8192 == blank), `token_prob`,
/// and `duration` (a bin index 0..4 mapped through `durationBins`). This decoder
/// reproduces the reference's blank inner-loop, decoder-output caching across
/// blank frames, force-blank anti-stall logic, and last-chunk finalization.
struct TdtConfig {
    var blankId = 8192
    var durationBins = [0, 1, 2, 3, 4]
    var maxSymbolsPerStep = 10
    var maxTokensPerChunk = 150
    var consecutiveBlankLimit = 5
    var encoderHiddenSize = 1024
    var decoderHiddenSize = 640
}

/// Result of one decode pass over a chunk.
struct TdtHypothesis {
    var tokens: [Int] = []
    var timestamps: [Int] = []
    var durations: [Int] = []
}

final class TdtDecoder {
    private let config: TdtConfig
    private let decoderModel: MLModel
    private let jointModel: MLModel
    private let options = MLPredictionOptions()

    // Reused inputs/outputs across steps to avoid per-step allocation.
    private let reusableTarget: MLMultiArray
    private let reusableTargetLength: MLMultiArray
    private let reusableEncoderStep: MLMultiArray
    private let reusableDecoderStep: MLMultiArray
    private let encoderStepStride: Int
    private let encoderStepPtr: UnsafeMutablePointer<Float>

    init(config: TdtConfig, decoderModel: MLModel, jointModel: MLModel) throws {
        self.config = config
        self.decoderModel = decoderModel
        self.jointModel = jointModel

        reusableTarget = try MLMultiArray(shape: [1, 1], dataType: .int32)
        reusableTargetLength = try MLMultiArray(shape: [1], dataType: .int32)
        reusableTargetLength[0] = NSNumber(value: 1)

        reusableEncoderStep = try ANEMemory.makeAlignedArray(
            shape: [1, NSNumber(value: config.encoderHiddenSize), 1], dataType: .float32)
        reusableDecoderStep = try ANEMemory.makeAlignedArray(
            shape: [1, NSNumber(value: config.decoderHiddenSize), 1], dataType: .float32)
        encoderStepStride = reusableEncoderStep.strides.map { $0.intValue }[1]
        encoderStepPtr = reusableEncoderStep.dataPointer.bindMemory(
            to: Float.self, capacity: config.encoderHiddenSize)
    }

    private struct JointDecision {
        let token: Int
        let probability: Float
        let durationBin: Int
    }

    private final class ReusableJointInput: NSObject, MLFeatureProvider {
        let encoderStep: MLMultiArray
        let decoderStep: MLMultiArray
        init(encoderStep: MLMultiArray, decoderStep: MLMultiArray) {
            self.encoderStep = encoderStep
            self.decoderStep = decoderStep
        }
        var featureNames: Set<String> { ["encoder_step", "decoder_step"] }
        func featureValue(for name: String) -> MLFeatureValue? {
            switch name {
            case "encoder_step": return MLFeatureValue(multiArray: encoderStep)
            case "decoder_step": return MLFeatureValue(multiArray: decoderStep)
            default: return nil
            }
        }
    }

    /// Greedy TDT decode over one encoder output.
    ///
    /// - encoderOutput: `[1, 1024, time]`
    /// - encoderSequenceLength: valid frame count reported by the encoder
    /// - actualAudioFrames: frames corresponding to real audio (excludes padding/context)
    /// - contextFrameAdjustment: starting frame offset (skip prepended context frames)
    /// - globalFrameOffset: added to timestamps so they're absolute across chunks
    func decode(
        encoderOutput: MLMultiArray,
        encoderSequenceLength: Int,
        actualAudioFrames: Int,
        state: TdtDecoderState,
        contextFrameAdjustment: Int = 0,
        isLastChunk: Bool = false,
        globalFrameOffset: Int = 0
    ) throws -> TdtHypothesis {
        guard encoderSequenceLength > 1 else { return TdtHypothesis() }

        let encoderFrames = try EncoderFrameView(
            encoderOutput: encoderOutput,
            validLength: encoderSequenceLength,
            expectedHiddenSize: config.encoderHiddenSize)

        var hypothesis = TdtHypothesis()
        var lastToken = state.lastToken

        var timeIndices = contextFrameAdjustment
        let effectiveSequenceLength = min(encoderSequenceLength, actualAudioFrames)
        var safeTimeIndices = min(timeIndices, effectiveSequenceLength - 1)
        var timeIndicesCurrentLabels = timeIndices
        var activeMask = timeIndices < effectiveSequenceLength
        let lastTimestep = effectiveSequenceLength - 1

        if timeIndices >= effectiveSequenceLength { return TdtHypothesis() }

        let jointInput = ReusableJointInput(
            encoderStep: reusableEncoderStep, decoderStep: reusableDecoderStep)

        // Prime decoder with blank (SOS) if this is a fresh utterance/chunk.
        if state.predictorOutput == nil && lastToken == nil {
            let primed = try runDecoder(token: config.blankId, state: state)
            state.predictorOutput = try extract(primed, "decoder")
            state.update(from: primed)
        }

        var lastEmissionTimestamp = -1
        var emissionsAtThisTimestamp = 0
        let maxSymbolsPerStep = config.maxSymbolsPerStep
        var tokensProcessedThisChunk = 0

        // ===== MAIN DECODE LOOP =====
        while activeMask {
            var label = lastToken ?? config.blankId

            // Decoder output: reuse cached projection when available, else run LSTM.
            let decoderOutput: MLFeatureProvider
            if let cached = state.predictorOutput {
                decoderOutput = try MLDictionaryFeatureProvider(dictionary: [
                    "decoder": MLFeatureValue(multiArray: cached)
                ])
            } else {
                let result = try runDecoder(token: label, state: state)
                decoderOutput = result
                state.update(from: result)
            }
            let decoderProjection = try extract(decoderOutput, "decoder")
            try normalizeDecoderProjection(decoderProjection, into: reusableDecoderStep)

            let decision = try runJoint(
                encoderFrames: encoderFrames, timeIndex: safeTimeIndices, input: jointInput)

            label = decision.token
            var duration = try mapDurationBin(decision.durationBin)
            var blankMask = (label == config.blankId)

            let currentTimeIndex = timeIndices
            if !blankMask && duration == 0
                && currentTimeIndex == lastEmissionTimestamp
                && emissionsAtThisTimestamp >= 1 {
                duration = 1
            }
            if blankMask && duration == 0 { duration = 1 }

            timeIndicesCurrentLabels = timeIndices
            timeIndices += duration
            safeTimeIndices = min(timeIndices, lastTimestep)
            activeMask = timeIndices < effectiveSequenceLength
            var advanceMask = activeMask && blankMask

            // ===== INNER BLANK LOOP =====
            // Reuse the decoder projection from outside the loop (blanks do not
            // change linguistic context). Skip silence quickly.
            while advanceMask {
                timeIndicesCurrentLabels = timeIndices
                let inner = try runJoint(
                    encoderFrames: encoderFrames, timeIndex: safeTimeIndices, input: jointInput)
                label = inner.token
                duration = try mapDurationBin(inner.durationBin)
                blankMask = (label == config.blankId)
                if blankMask && duration == 0 { duration = 1 }
                timeIndices += duration
                safeTimeIndices = min(timeIndices, lastTimestep)
                activeMask = timeIndices < effectiveSequenceLength
                advanceMask = activeMask && blankMask
            }

            // Emit non-blank token and update decoder state.
            if activeMask && label != config.blankId {
                tokensProcessedThisChunk += 1
                if tokensProcessedThisChunk > config.maxTokensPerChunk { break }

                hypothesis.tokens.append(label)
                hypothesis.timestamps.append(timeIndicesCurrentLabels + globalFrameOffset)
                hypothesis.durations.append(duration)
                lastToken = label

                let step = try runDecoder(token: label, state: state)
                state.update(from: step)
                state.predictorOutput = try extract(step, "decoder")

                if timeIndicesCurrentLabels == lastEmissionTimestamp {
                    emissionsAtThisTimestamp += 1
                } else {
                    lastEmissionTimestamp = timeIndicesCurrentLabels
                    emissionsAtThisTimestamp = 1
                }
                if emissionsAtThisTimestamp >= maxSymbolsPerStep {
                    timeIndices = min(timeIndices + 1, lastTimestep)
                    safeTimeIndices = min(timeIndices, lastTimestep)
                    emissionsAtThisTimestamp = 0
                    lastEmissionTimestamp = -1
                }
            }

            activeMask = timeIndices < effectiveSequenceLength
        }

        // ===== LAST-CHUNK FINALIZATION =====
        if isLastChunk {
            var additionalSteps = 0
            var consecutiveBlanks = 0
            let maxConsecutiveBlanks = config.consecutiveBlankLimit
            var finalToken = lastToken ?? config.blankId
            var finalProcessingTimeIndices = timeIndices

            while additionalSteps < maxSymbolsPerStep && consecutiveBlanks < maxConsecutiveBlanks {
                let decoderOutput: MLFeatureProvider
                if let cached = state.predictorOutput {
                    decoderOutput = try MLDictionaryFeatureProvider(dictionary: [
                        "decoder": MLFeatureValue(multiArray: cached)
                    ])
                } else {
                    let result = try runDecoder(token: finalToken, state: state)
                    decoderOutput = result
                    state.update(from: result)
                }

                let frameVariations = [
                    min(finalProcessingTimeIndices, encoderFrames.count - 1),
                    min(effectiveSequenceLength - 1, encoderFrames.count - 1),
                    min(max(0, effectiveSequenceLength - 2), encoderFrames.count - 1),
                ]
                let frameIndex = frameVariations[additionalSteps % frameVariations.count]

                let finalProjection = try extract(decoderOutput, "decoder")
                try normalizeDecoderProjection(finalProjection, into: reusableDecoderStep)

                let decision = try runJoint(
                    encoderFrames: encoderFrames, timeIndex: frameIndex, input: jointInput)
                let token = decision.token
                let duration = try mapDurationBin(decision.durationBin)

                if token == config.blankId {
                    consecutiveBlanks += 1
                } else {
                    consecutiveBlanks = 0
                    hypothesis.tokens.append(token)
                    let finalTimestamp =
                        min(finalProcessingTimeIndices, effectiveSequenceLength - 1) + globalFrameOffset
                    hypothesis.timestamps.append(finalTimestamp)
                    hypothesis.durations.append(duration)
                    lastToken = token

                    let step = try runDecoder(token: token, state: state)
                    state.update(from: step)
                    state.predictorOutput = try extract(step, "decoder")
                    finalToken = token
                }

                finalProcessingTimeIndices = min(
                    finalProcessingTimeIndices + max(1, duration), effectiveSequenceLength)
                additionalSteps += 1
            }
            state.predictorOutput = nil
        }

        state.lastToken = lastToken

        // Clear cached predictor output after sentence-final punctuation so it is
        // not duplicated across chunk boundaries (period/question/exclamation).
        if let last = lastToken, [7883, 7952, 7948].contains(last) {
            state.predictorOutput = nil
        }

        return hypothesis
    }

    // MARK: - Model execution

    private func runDecoder(token: Int, state: TdtDecoderState) throws -> MLFeatureProvider {
        reusableTarget[0] = NSNumber(value: token)
        let input = try MLDictionaryFeatureProvider(dictionary: [
            "targets": MLFeatureValue(multiArray: reusableTarget),
            "target_length": MLFeatureValue(multiArray: reusableTargetLength),
            "h_in": MLFeatureValue(multiArray: state.hiddenState),
            "c_in": MLFeatureValue(multiArray: state.cellState),
        ])
        return try decoderModel.prediction(from: input, options: options)
    }

    private func runJoint(
        encoderFrames: EncoderFrameView, timeIndex: Int, input: ReusableJointInput
    ) throws -> JointDecision {
        try encoderFrames.copyFrame(
            at: timeIndex, into: encoderStepPtr, destinationStride: encoderStepStride)

        // NOTE: output backings are intentionally not set for the joint model.
        // Its outputs (token_id/token_prob/duration) are scalar [1,1,1] tensors
        // and CoreML rejects MultiArray output backings for them
        // ("Output feature doesn't support output backing"). Letting CoreML
        // allocate the tiny outputs is negligible cost.
        let output = try jointModel.prediction(from: input)

        let tokenArray = try extract(output, "token_id")
        let probArray = try extract(output, "token_prob")
        let durationArray = try extract(output, "duration")

        let token = Int(tokenArray.dataPointer.bindMemory(to: Int32.self, capacity: 1)[0])
        let prob = probArray.dataPointer.bindMemory(to: Float.self, capacity: 1)[0]
        let durationBin = Int(durationArray.dataPointer.bindMemory(to: Int32.self, capacity: 1)[0])
        return JointDecision(token: token, probability: prob, durationBin: durationBin)
    }

    /// Copy the decoder projection into the `[1, 640, 1]` joint input buffer,
    /// handling either `[1, 640, 1]` or `[1, 1, 640]` source layouts.
    private func normalizeDecoderProjection(_ projection: MLMultiArray, into destination: MLMultiArray) throws {
        let hiddenSize = config.decoderHiddenSize
        let shape = projection.shape.map { $0.intValue }
        guard shape.count == 3, shape[0] == 1, projection.dataType == .float32 else {
            throw SidecarError.shape("Invalid decoder projection: \(shape)")
        }
        let hiddenAxis: Int
        if shape[2] == hiddenSize {
            hiddenAxis = 2
        } else if shape[1] == hiddenSize {
            hiddenAxis = 1
        } else {
            throw SidecarError.shape("Decoder projection hidden mismatch: \(shape)")
        }

        let strides = projection.strides.map { $0.intValue }
        let hiddenStride = strides[hiddenAxis]
        let source = projection.dataPointer.bindMemory(to: Float.self, capacity: projection.count)
        let destPtr = destination.dataPointer.bindMemory(to: Float.self, capacity: hiddenSize)
        let destStride = destination.strides.map { $0.intValue }[1]

        if hiddenStride == 1 && destStride == 1 {
            destPtr.update(from: source, count: hiddenSize)
        } else {
            cblas_scopy(Int32(hiddenSize), source, Int32(hiddenStride), destPtr, Int32(destStride))
        }
    }

    private func mapDurationBin(_ bin: Int) throws -> Int {
        guard bin >= 0 && bin < config.durationBins.count else {
            throw SidecarError.shape("Duration bin out of range: \(bin)")
        }
        return config.durationBins[bin]
    }

    private func extract(_ provider: MLFeatureProvider, _ key: String) throws -> MLMultiArray {
        guard let v = provider.featureValue(for: key)?.multiArrayValue else {
            throw SidecarError.shape("Missing feature \(key)")
        }
        return v
    }
}
