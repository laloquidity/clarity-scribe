import CoreML
import Darwin
import Foundation

/// ANE-aligned MLMultiArray allocation.
///
/// Ported and simplified from FluidInference/FluidAudio
/// (Sources/FluidAudio/Shared/ANEMemoryUtils.swift), Apache-2.0.
/// The Apple Neural Engine prefers 64-byte aligned buffers for efficient DMA
/// transfers, so the small hot-path tensors (encoder_step / decoder_step / LSTM
/// state) are allocated with `posix_memalign` and a matching `free` deallocator.
enum ANEMemory {

    /// ANE requires 64-byte alignment for optimal DMA transfers.
    static let alignment = 64

    enum ANEMemoryError: Error {
        case allocationFailed
    }

    /// Create a contiguous, 64-byte-aligned `MLMultiArray`.
    ///
    /// Strides are the natural contiguous strides for `shape` (we keep it simple
    /// and contiguous rather than tile-padding, which keeps frame copies trivial).
    static func makeAlignedArray(
        shape: [NSNumber],
        dataType: MLMultiArrayDataType,
        zeroClear: Bool = true
    ) throws -> MLMultiArray {
        let elementSize = elementSize(for: dataType)

        // Natural contiguous strides (last dim has stride 1).
        var strides = [Int](repeating: 1, count: shape.count)
        if shape.count > 1 {
            for i in stride(from: shape.count - 2, through: 0, by: -1) {
                strides[i] = strides[i + 1] * shape[i + 1].intValue
            }
        }
        let totalElements = shape.isEmpty ? 0 : strides[0] * shape[0].intValue

        let bytesNeeded = totalElements * elementSize
        let alignedBytes = max(alignment, ((bytesNeeded + alignment - 1) / alignment) * alignment)

        var alignedPointer: UnsafeMutableRawPointer?
        let result = posix_memalign(&alignedPointer, alignment, alignedBytes)
        guard result == 0, let pointer = alignedPointer else {
            throw ANEMemoryError.allocationFailed
        }
        if zeroClear {
            memset(pointer, 0, alignedBytes)
        }

        return try MLMultiArray(
            dataPointer: pointer,
            shape: shape,
            dataType: dataType,
            strides: strides.map { NSNumber(value: $0) },
            deallocator: { bytes in Darwin.free(bytes) }
        )
    }

    static func elementSize(for dataType: MLMultiArrayDataType) -> Int {
        switch dataType {
        case .float16: return 2
        case .float32, .float: return 4
        case .float64, .double: return 8
        case .int32: return MemoryLayout<Int32>.stride
        default: return MemoryLayout<Float>.stride
        }
    }
}
