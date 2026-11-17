import Foundation
import AVFoundation

// MARK: - LoudnessAnalyzer
// Native port of the web Master Check's measurement + triage stack
// (src/lib/loudness.ts): ITU-R BS.1770-4 integrated loudness with K-weighting
// and two-stage gating, the loudest-3s short-term window, raw sample peak,
// per-DSP normalization deltas and the mastering verdict.
//
// The web implementation holds prefix-sum arrays for the whole decoded file
// (~1 GB peak on a 10-minute mix — it needs a hard size gate for phones).
// This port streams instead: AVAudioFile is read in chunks, each channel runs
// through the same K-weighting biquads with persistent state, and all that is
// retained is one Double per 100 ms hop (the summed squared energy across
// channels). The 400 ms gating blocks (75% overlap) and 3 s short-term windows
// are then exact sums of 4 and 30 consecutive hops — so a mix of any length
// measures in a few MB of memory. Window edges are quantized to the 100 ms hop
// instead of the exact sample, which moves readings by well under 0.1 LU.

struct LoudnessMeasurement {
    /// Gated integrated loudness (LUFS). -infinity when nothing survives the gates.
    let integratedLufs: Double
    /// Loudest 3-second window (LUFS, ungated).
    let shortTermMaxLufs: Double
    /// Max |sample| in dBFS. Sample peak, not oversampled true peak.
    let samplePeakDb: Double
    /// 400 ms blocks that survived both gates.
    let gatedBlockCount: Int
}

enum LoudnessIssueLevel { case error, warning, info }
struct LoudnessIssue: Identifiable {
    let id = UUID()
    let level: LoudnessIssueLevel
    let message: String
}

struct DspDelta: Identifiable {
    var id: String { name }
    let name: String
    /// Positive = the platform turns the master down by this much. Nil when unmeasurable.
    let deltaDb: Double?
}

enum LoudnessAnalyzerError: LocalizedError {
    case unreadable(String)
    var errorDescription: String? {
        switch self {
        case .unreadable(let detail): return detail
        }
    }
}

enum LoudnessAnalyzer {

    // MARK: - Constants (identical to src/lib/loudness.ts)

    private static let absoluteGateLufs = -70.0
    private static let relativeGateLu = -10.0
    /// The −0.691 offset calibrates a 997 Hz full-scale sine per the spec.
    private static let loudnessOffset = -0.691

    /// What the major DSPs normalize playback to.
    static let dspTargets: [(name: String, lufs: Double)] = [
        ("Spotify", -14), ("YouTube", -14), ("Tidal", -14), ("Apple Music", -16),
    ]

    // MARK: - K-weighting
    // Same per-sample-rate design libebur128 uses — bilinear transform with
    // K = tan(π·f0/fs) prewarping. Constants match the web port digit for digit.

    private struct Biquad { let b0, b1, b2, a1, a2: Double }

    private static func kWeighting(sampleRate: Double) -> (shelf: Biquad, highpass: Biquad) {
        // Stage 1: high-shelf (+~4 dB above ~1.5 kHz).
        let shelf: Biquad = {
            let f0 = 1681.974450955533
            let gainDb = 3.999843853973347
            let q = 0.7071752369554196
            let k = tan(Double.pi * f0 / sampleRate)
            let vh = pow(10, gainDb / 20)
            let vb = pow(vh, 0.4996667741545416)
            let a0 = 1 + k / q + k * k
            return Biquad(
                b0: (vh + (vb * k) / q + k * k) / a0,
                b1: (2 * (k * k - vh)) / a0,
                b2: (vh - (vb * k) / q + k * k) / a0,
                a1: (2 * (k * k - 1)) / a0,
                a2: (1 - k / q + k * k) / a0
            )
        }()
        // Stage 2: high-pass (~38 Hz, RLB curve) — numerator deliberately
        // unnormalized at [1, −2, 1], per the spec's own table.
        let highpass: Biquad = {
            let f0 = 38.13547087602444
            let q = 0.5003270373238773
            let k = tan(Double.pi * f0 / sampleRate)
            let a0 = 1 + k / q + k * k
            return Biquad(
                b0: 1, b1: -2, b2: 1,
                a1: (2 * (k * k - 1)) / a0,
                a2: (1 - k / q + k * k) / a0
            )
        }()
        return (shelf, highpass)
    }

    /// Direct Form I state, persistent across chunks (the stream is one signal).
    private struct BiquadState {
        var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
        mutating func process(_ x0: Double, _ c: Biquad) -> Double {
            let y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
            x2 = x1; x1 = x0
            y2 = y1; y1 = y0
            return y0
        }
    }

    private static func toLufs(_ meanSquare: Double) -> Double {
        meanSquare > 0 ? loudnessOffset + 10 * log10(meanSquare) : -.infinity
    }

    // MARK: - Measurement

    static func measure(fileURL: URL) throws -> LoudnessMeasurement {
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: fileURL)
        } catch {
            throw LoudnessAnalyzerError.unreadable("Could not decode this audio file")
        }
        let format = file.processingFormat
        let sr = format.sampleRate
        let channelCount = Int(format.channelCount)
        guard sr >= 8000, channelCount > 0, file.length > 0 else {
            throw LoudnessAnalyzerError.unreadable("No audio samples to measure")
        }

        let (shelf, highpass) = kWeighting(sampleRate: sr)
        var shelfState = [BiquadState](repeating: BiquadState(), count: channelCount)
        var hpState = [BiquadState](repeating: BiquadState(), count: channelCount)

        // One retained Double per 100 ms hop: squared K-weighted energy summed
        // across channels. Blocks and short-term windows are hop sums.
        let hopLen = max(1, Int((0.1 * sr).rounded()))
        var hopEnergies: [Double] = []
        hopEnergies.reserveCapacity(Int(Double(file.length) / Double(hopLen)) + 2)
        var currentHopSum = 0.0
        var samplesIntoHop = 0
        var peak: Double = 0

        let chunkFrames: AVAudioFrameCount = 65536
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else {
            throw LoudnessAnalyzerError.unreadable("Could not allocate a decode buffer")
        }

        while file.framePosition < file.length {
            try file.read(into: buffer, frameCount: chunkFrames)
            let n = Int(buffer.frameLength)
            if n == 0 { break }
            guard let channels = buffer.floatChannelData else {
                throw LoudnessAnalyzerError.unreadable("Unsupported audio buffer layout")
            }
            for i in 0..<n {
                var frameEnergy = 0.0
                for c in 0..<channelCount {
                    let raw = Double(channels[c][i])
                    let a = abs(raw)
                    if a > peak { peak = a }
                    let filtered = hpState[c].process(shelfState[c].process(raw, shelf), highpass)
                    frameEnergy += filtered * filtered
                }
                currentHopSum += frameEnergy
                samplesIntoHop += 1
                if samplesIntoHop == hopLen {
                    hopEnergies.append(currentHopSum)
                    currentHopSum = 0
                    samplesIntoHop = 0
                }
            }
        }
        // A signal shorter than one hop still measures (single partial hop);
        // otherwise the trailing sub-100 ms remainder is dropped, matching the
        // web's partial-block tolerance.
        var effectiveHopLen = hopLen
        if hopEnergies.isEmpty && samplesIntoHop > 0 {
            hopEnergies.append(currentHopSum)
            effectiveHopLen = samplesIntoHop
        }
        let hopCount = hopEnergies.count
        guard hopCount > 0 else {
            throw LoudnessAnalyzerError.unreadable("No audio samples to measure")
        }

        // 400 ms blocks (4 hops) at 75% overlap (1-hop stride); short signals
        // are one partial block rather than rejected.
        var blockMeanSquares: [Double] = []
        if hopCount >= 4 {
            for i in 0...(hopCount - 4) {
                let sum = hopEnergies[i] + hopEnergies[i + 1] + hopEnergies[i + 2] + hopEnergies[i + 3]
                blockMeanSquares.append(sum / Double(4 * hopLen))
            }
        } else {
            let sum = hopEnergies.reduce(0, +)
            blockMeanSquares.append(sum / Double(hopCount * effectiveHopLen))
        }

        // Gate 1 (absolute −70 LUFS), then gate 2 (−10 LU below the gated mean).
        let absGated = blockMeanSquares.filter { toLufs($0) > absoluteGateLufs }
        var integrated = -Double.infinity
        var gatedCount = 0
        if !absGated.isEmpty {
            let absMean = absGated.reduce(0, +) / Double(absGated.count)
            let relThreshold = toLufs(absMean) + relativeGateLu
            let relGated = absGated.filter { toLufs($0) > relThreshold }
            if !relGated.isEmpty {
                integrated = toLufs(relGated.reduce(0, +) / Double(relGated.count))
                gatedCount = relGated.count
            }
        }

        // Loudest 3 s window (30 hops), 1 s stride, final window flushed
        // against the end so a hot outro is not missed.
        var stMax = -Double.infinity
        let stLen = min(hopCount, 30)
        var start = 0
        while true {
            let end = min(start + stLen, hopCount)
            let winStart = end - stLen
            var sum = 0.0
            for i in winStart..<end { sum += hopEnergies[i] }
            let lufs = toLufs(sum / Double(stLen * effectiveHopLen))
            if lufs > stMax { stMax = lufs }
            if end >= hopCount { break }
            start += 10
        }

        return LoudnessMeasurement(
            integratedLufs: integrated,
            shortTermMaxLufs: stMax,
            samplePeakDb: peak > 0 ? 20 * log10(peak) : -.infinity,
            gatedBlockCount: gatedCount
        )
    }

    // MARK: - DSP deltas

    /// Positive delta = the platform turns it down by that much.
    static func dspDeltas(_ m: LoudnessMeasurement) -> [DspDelta] {
        dspTargets.map { target in
            DspDelta(name: target.name,
                     deltaDb: m.integratedLufs.isFinite ? m.integratedLufs - target.lufs : nil)
        }
    }

    // MARK: - Verdict (same triage and copy as the web masterVerdict)

    static func verdict(_ m: LoudnessMeasurement) -> [LoudnessIssue] {
        guard m.integratedLufs.isFinite else {
            return [LoudnessIssue(level: .error, message: "Too quiet to measure — the whole mix sits under the −70 LUFS gate. Check the export.")]
        }
        let lufs = m.integratedLufs
        var issues: [LoudnessIssue] = []

        if m.samplePeakDb > -0.1 {
            let tail = lufs > -14
                ? "For a master this loud, Spotify recommends keeping true peak under −2 dB."
                : "Aim for at least −1 dB of headroom."
            issues.append(LoudnessIssue(level: .warning, message: "Peaks hit \(formatDb(m.samplePeakDb)) dBFS — lossy transcodes (Spotify/Apple) can clip. \(tail)"))
        } else if m.samplePeakDb > -1 {
            issues.append(LoudnessIssue(level: .info, message: "Sample peak \(formatDb(m.samplePeakDb)) dBFS — tight headroom; true peaks likely exceed it after encoding."))
        }

        if lufs > -5 {
            issues.append(LoudnessIssue(level: .warning, message: "Extremely loud master (\(formatLufs(lufs))) — beyond even club norms. Streaming normalization undoes the level; only the limiting stays."))
        } else if lufs > -9 {
            issues.append(LoudnessIssue(level: .info, message: "Loud, club-level master (\(formatLufs(lufs))) — standard for EDM/techno. Streaming plays it normalized to target; DJ sets and clubs get the full level. Peak headroom is the number to watch."))
        } else if lufs < -20 {
            issues.append(LoudnessIssue(level: .warning, message: "Quiet master (\(formatLufs(lufs))). Platforms only boost with a limiter (or not at all) — it will play noticeably quieter than other releases."))
        }

        if issues.isEmpty {
            issues.append(LoudnessIssue(level: .info, message: "\(formatLufs(lufs)) integrated, \(formatDb(m.samplePeakDb)) dBFS peak — healthy for streaming."))
        }
        return issues
    }

    // MARK: - Formatting

    static func formatLufs(_ x: Double) -> String {
        x.isFinite ? String(format: "%.1f LUFS", x) : "−∞ LUFS"
    }

    static func formatDb(_ x: Double) -> String {
        x.isFinite ? String(format: "%.1f", x) : "−∞"
    }
}
