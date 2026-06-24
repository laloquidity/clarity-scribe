import Accelerate
import CoreML
import Foundation

/// Stride-aware view over encoder output `[1, hidden, time]` (or `[1, time, hidden]`)
/// that copies a single time frame's hidden vector without materializing slices.
///
/// Ported from FluidInference/FluidAudio (EncoderFrameView.swift), Apache-2.0.
struct EncoderFrameView {
    let hiddenSize: Int
    let count: Int

    private let timeStride: Int
    private let hiddenStride: Int
    private let timeBaseOffset: Int
    private let basePointer: UnsafeMutablePointer<Float>

    init(encoderOutput: MLMultiArray, validLength: Int, expectedHiddenSize: Int) throws {
        let shape = encoderOutput.shape.map { $0.intValue }
        guard shape.count == 3, shape[0] == 1 else {
            throw SidecarError.shape("Invalid encoder output shape: \(shape)")
        }
        guard encoderOutput.dataType == .float32 else {
            throw SidecarError.shape("Encoder output must be float32")
        }

        let hiddenAxis: Int
        let timeAxis: Int
        if shape[1] == expectedHiddenSize {
            hiddenAxis = 1
            timeAxis = 2
        } else if shape[2] == expectedHiddenSize {
            hiddenAxis = 2
            timeAxis = 1
        } else {
            throw SidecarError.shape("Encoder hidden size mismatch: \(shape), expected \(expectedHiddenSize)")
        }

        let strides = encoderOutput.strides.map { $0.intValue }
        self.hiddenSize = expectedHiddenSize
        self.hiddenStride = strides[hiddenAxis]
        self.timeStride = strides[timeAxis]

        let availableFrames = shape[timeAxis]
        self.count = min(validLength, availableFrames)
        guard count > 0 else { throw SidecarError.shape("Encoder output has no frames") }

        self.basePointer = encoderOutput.dataPointer.bindMemory(
            to: Float.self, capacity: encoderOutput.count)
        self.timeBaseOffset = timeStride >= 0 ? 0 : (availableFrames - 1) * timeStride
    }

    /// Copy frame `index`'s hidden vector into `destination` (length `hiddenSize`).
    func copyFrame(at index: Int, into destination: UnsafeMutablePointer<Float>, destinationStride: Int) throws {
        guard index >= 0 && index < count else {
            throw SidecarError.shape("Encoder frame index out of range: \(index)")
        }
        let frameOffset = timeBaseOffset + index * timeStride
        let source = basePointer.advanced(by: frameOffset)

        if hiddenStride == 1 && destinationStride == 1 {
            destination.update(from: source, count: hiddenSize)
        } else {
            cblas_scopy(
                Int32(hiddenSize), source, Int32(hiddenStride),
                destination, Int32(destinationStride))
        }
    }
}
