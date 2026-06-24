import CoreML
import Foundation

/// LSTM hidden/cell state for the Parakeet prediction network, plus the small
/// pieces of cross-step bookkeeping the TDT greedy loop needs.
///
/// Ported from FluidInference/FluidAudio (TdtDecoderState.swift), Apache-2.0.
/// Shapes match the Decoder model: h_in/c_in are [2, 1, 640] (2 LSTM layers).
final class TdtDecoderState {
    var hiddenState: MLMultiArray
    var cellState: MLMultiArray

    /// Last decoded (non-blank) token, used as decoder input for the next step.
    var lastToken: Int?

    /// Cached decoder ("decoder") projection. Mirrors NeMo: the SOS == blank
    /// priming output is reused for the first joint at chunk start, and reused
    /// across blank frames (blanks don't change linguistic context).
    var predictorOutput: MLMultiArray?

    static let decoderLayers = 2
    static let decoderHiddenSize = 640

    init() {
        hiddenState = try! ANEMemory.makeAlignedArray(
            shape: [NSNumber(value: Self.decoderLayers), 1, NSNumber(value: Self.decoderHiddenSize)],
            dataType: .float32
        )
        cellState = try! ANEMemory.makeAlignedArray(
            shape: [NSNumber(value: Self.decoderLayers), 1, NSNumber(value: Self.decoderHiddenSize)],
            dataType: .float32
        )
        reset()
    }

    /// Reset to a fresh-utterance state (zeroed LSTM, no cached output/token).
    func reset() {
        zero(hiddenState)
        zero(cellState)
        lastToken = nil
        predictorOutput = nil
    }

    /// Adopt the h_out/c_out produced by a decoder forward pass.
    func update(from output: MLFeatureProvider) {
        if let h = output.featureValue(for: "h_out")?.multiArrayValue { hiddenState = h }
        if let c = output.featureValue(for: "c_out")?.multiArrayValue { cellState = c }
    }

    private func zero(_ array: MLMultiArray) {
        let count = array.count
        let ptr = array.dataPointer.bindMemory(to: Float.self, capacity: count)
        ptr.update(repeating: 0, count: count)
    }
}
