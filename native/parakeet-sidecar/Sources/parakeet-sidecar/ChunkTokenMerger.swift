import Foundation

/// Overlap merge for token windows produced by chunked ASR.
///
/// Ported from FluidInference/FluidAudio (Shared/AsrChunkTokenMerger.swift),
/// Apache-2.0. Aligns tokens in the overlap region (contiguous run first, then
/// LCS) and splices windows, falling back to a timestamp-midpoint cut.
enum ChunkTokenMerger {
    typealias TokenWindow = (token: Int, timestamp: Int, duration: Int)

    private struct Indexed {
        let index: Int
        let token: TokenWindow
        let start: Double
    }

    static let samplesPerEncoderFrame = 1280
    static let sampleRate = 16000

    static func merge(_ chunks: [[TokenWindow]], overlapSeconds: Double) -> [TokenWindow] {
        guard var merged = chunks.first else { return [] }
        for chunk in chunks.dropFirst() {
            merged = mergePair(merged, chunk, overlapSeconds: overlapSeconds)
        }
        return merged
    }

    static func mergePair(
        _ left: [TokenWindow], _ right: [TokenWindow], overlapSeconds: Double
    ) -> [TokenWindow] {
        if left.isEmpty { return right }
        if right.isEmpty { return left }

        let frameDuration = Double(samplesPerEncoderFrame) / Double(sampleRate)
        let halfOverlap = overlapSeconds / 2

        func startTime(_ t: TokenWindow) -> Double { Double(t.timestamp) * frameDuration }
        func endTime(_ t: TokenWindow) -> Double { startTime(t) + frameDuration }

        let leftEndTime = endTime(left.last!)
        let rightStartTime = startTime(right.first!)
        if leftEndTime <= rightStartTime { return left + right }

        let overlapLeft: [Indexed] = left.enumerated().compactMap { offset, t in
            let start = startTime(t)
            guard start + frameDuration > rightStartTime - overlapSeconds else { return nil }
            return Indexed(index: offset, token: t, start: start)
        }
        let overlapRight: [Indexed] = right.enumerated().compactMap { offset, t in
            let start = startTime(t)
            guard start < leftEndTime + overlapSeconds else { return nil }
            return Indexed(index: offset, token: t, start: start)
        }

        guard overlapLeft.count >= 2 && overlapRight.count >= 2 else {
            return mergeByMidpoint(left, right, leftEndTime, rightStartTime, frameDuration)
        }

        let minimumPairs = max(overlapLeft.count / 2, 1)
        let contiguous = bestContiguous(overlapLeft, overlapRight, tolerance: halfOverlap)
        if contiguous.count >= minimumPairs {
            return mergeUsing(contiguous, overlapLeft, overlapRight, left, right)
        }
        let lcs = longestCommonSubsequence(overlapLeft, overlapRight, tolerance: halfOverlap)
        guard !lcs.isEmpty else {
            return mergeByMidpoint(left, right, leftEndTime, rightStartTime, frameDuration)
        }
        return mergeUsing(lcs, overlapLeft, overlapRight, left, right)
    }

    private static func tokensMatch(_ a: Indexed, _ b: Indexed, tolerance: Double) -> Bool {
        a.token.token == b.token.token && abs(a.start - b.start) < tolerance
    }

    private static func bestContiguous(
        _ left: [Indexed], _ right: [Indexed], tolerance: Double
    ) -> [(Int, Int)] {
        var best: [(Int, Int)] = []
        for i in 0..<left.count {
            for j in 0..<right.count where tokensMatch(left[i], right[j], tolerance: tolerance) {
                var current: [(Int, Int)] = []
                var k = i, l = j
                while k < left.count && l < right.count && tokensMatch(left[k], right[l], tolerance: tolerance) {
                    current.append((k, l)); k += 1; l += 1
                }
                if current.count > best.count { best = current }
            }
        }
        return best
    }

    private static func longestCommonSubsequence(
        _ left: [Indexed], _ right: [Indexed], tolerance: Double
    ) -> [(Int, Int)] {
        let m = left.count, n = right.count
        var dp = Array(repeating: Array(repeating: 0, count: n + 1), count: m + 1)
        for i in 1...m {
            for j in 1...n {
                if tokensMatch(left[i - 1], right[j - 1], tolerance: tolerance) {
                    dp[i][j] = dp[i - 1][j - 1] + 1
                } else {
                    dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
                }
            }
        }
        var pairs: [(Int, Int)] = []
        var i = m, j = n
        while i > 0 && j > 0 {
            if tokensMatch(left[i - 1], right[j - 1], tolerance: tolerance) {
                pairs.append((i - 1, j - 1)); i -= 1; j -= 1
            } else if dp[i - 1][j] > dp[i][j - 1] {
                i -= 1
            } else {
                j -= 1
            }
        }
        return pairs.reversed()
    }

    private static func mergeUsing(
        _ matches: [(Int, Int)], _ overlapLeft: [Indexed], _ overlapRight: [Indexed],
        _ left: [TokenWindow], _ right: [TokenWindow]
    ) -> [TokenWindow] {
        let leftIndices = matches.map { overlapLeft[$0.0].index }
        let rightIndices = matches.map { overlapRight[$0.1].index }
        var result: [TokenWindow] = []
        if let firstLeft = leftIndices.first, firstLeft > 0 {
            result.append(contentsOf: left[..<firstLeft])
        }
        for idx in 0..<matches.count {
            let leftIndex = leftIndices[idx]
            let rightIndex = rightIndices[idx]
            result.append(left[leftIndex])
            guard idx < matches.count - 1 else { continue }
            let nextLeft = leftIndices[idx + 1]
            let nextRight = rightIndices[idx + 1]
            let gapLeft = nextLeft > leftIndex + 1 ? Array(left[(leftIndex + 1)..<nextLeft]) : []
            let gapRight = nextRight > rightIndex + 1 ? Array(right[(rightIndex + 1)..<nextRight]) : []
            result.append(contentsOf: gapRight.count > gapLeft.count ? gapRight : gapLeft)
        }
        if let lastRight = rightIndices.last, lastRight + 1 < right.count {
            result.append(contentsOf: right[(lastRight + 1)...])
        }
        return result
    }

    private static func mergeByMidpoint(
        _ left: [TokenWindow], _ right: [TokenWindow],
        _ leftEndTime: Double, _ rightStartTime: Double, _ frameDuration: Double
    ) -> [TokenWindow] {
        let cutoff = (leftEndTime + rightStartTime) / 2
        let trimmedLeft = left.filter { Double($0.timestamp) * frameDuration <= cutoff }
        let trimmedRight = right.filter { Double($0.timestamp) * frameDuration >= cutoff }
        return trimmedLeft + trimmedRight
    }
}
