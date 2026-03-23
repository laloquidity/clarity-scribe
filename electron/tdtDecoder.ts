/**
 * TDT (Token-and-Duration Transducer) Decoder for Parakeet
 * Implements greedy beam search to decode encoder output into text.
 * Reference: groxaxo/parakeet-tdt-0.6b-v3-fastapi-openai
 */

import * as ort from 'onnxruntime-node';

// Special tokens
const BLANK_TOKEN = 1024;  // Default blank token for TDT models

export interface TDTResult {
    text: string;
    tokens: number[];
}

/**
 * Load vocabulary from vocab.txt
 * Format: one token per line
 */
export function loadVocabulary(vocabPath: string): string[] {
    const fs = require('fs');
    const content = fs.readFileSync(vocabPath, 'utf-8');
    return content.split('\n').map((line: string) => line.trim());
}

/**
 * TDT Greedy decode: process encoder output through the joint network
 * 
 * The TDT model has:
 * - Encoder: processes audio features → encoder output + encoded lengths
 * - Decoder-Joint: takes encoder output + previous tokens → next token prediction + duration
 * 
 * Greedy strategy: always pick the most likely token at each step
 */
export async function tdtGreedyDecode(
    decoderSession: ort.InferenceSession,
    encoderOutput: ort.Tensor,
    encodedLengths: ort.Tensor,
    vocab: string[],
    blankToken: number = BLANK_TOKEN,
): Promise<TDTResult> {
    const batchSize = 1;
    const encoderOutData = encoderOutput.data as Float32Array;
    const encoderDims = encoderOutput.dims;  // [1, T, D]
    const T = Number(encoderDims[1]);
    const D = Number(encoderDims[2]);
    const maxLength = Number((encodedLengths.data as BigInt64Array)[0]);

    const tokens: number[] = [];
    const decodedTokens: number[] = [blankToken]; // Start with blank

    let t = 0;
    const maxIter = T * 10; // Safety limit
    let iter = 0;

    while (t < maxLength && iter < maxIter) {
        iter++;

        // Extract encoder output at timestep t: shape [1, 1, D]
        const encSlice = new Float32Array(D);
        for (let d = 0; d < D; d++) {
            encSlice[d] = encoderOutData[t * D + d];
        }
        const encTensor = new ort.Tensor('float32', encSlice, [1, 1, D]);

        // Previous token: shape [1, 1]
        const lastToken = decodedTokens[decodedTokens.length - 1];
        const prevTokenTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(lastToken)]), [1, 1]);

        // Run decoder-joint
        let result: ort.InferenceSession.OnnxValueMapType;
        try {
            result = await decoderSession.run({
                encoder_output: encTensor,
                targets: prevTokenTensor,
            });
        } catch {
            // Try alternative input names
            try {
                result = await decoderSession.run({
                    'encoder_output': encTensor,
                    'decoder_input': prevTokenTensor,
                });
            } catch (e2) {
                console.error('[TDT] Decoder run failed:', e2);
                break;
            }
        }

        // Get logits and duration logits
        const logits = result.logits || result.output || Object.values(result)[0];
        const logitsData = logits.data as Float32Array;
        const vocabSize = logits.dims[logits.dims.length - 1];

        // Greedy: pick best non-blank token
        let bestToken = 0;
        let bestScore = -Infinity;
        for (let v = 0; v < vocabSize; v++) {
            if (logitsData[v] > bestScore) {
                bestScore = logitsData[v];
                bestToken = v;
            }
        }

        if (bestToken === blankToken || bestToken === 0) {
            // Blank/pad token — advance time step
            // Check for duration prediction
            const durationOutput = result.durations || result.duration_logits;
            let duration = 1;
            if (durationOutput) {
                const durData = durationOutput.data as Float32Array;
                // Find the argmax of duration predictions
                let bestDur = 0;
                let bestDurScore = -Infinity;
                for (let d = 0; d < durData.length; d++) {
                    if (durData[d] > bestDurScore) {
                        bestDurScore = durData[d];
                        bestDur = d;
                    }
                }
                duration = Math.max(1, bestDur + 1);
            }
            t += duration;
        } else {
            // Valid token — record it
            tokens.push(bestToken);
            decodedTokens.push(bestToken);
        }
    }

    // Decode tokens to text using vocabulary
    let text = '';
    for (const token of tokens) {
        if (token < vocab.length) {
            let piece = vocab[token];
            // SentencePiece encoding: ▁ = space
            piece = piece.replace(/▁/g, ' ');
            text += piece;
        }
    }

    text = text.trim();
    // Clean up punctuation spacing
    text = text.replace(/\s+([.,!?;:])/g, '$1');
    text = text.replace(/\s+/g, ' ');

    return { text, tokens };
}
