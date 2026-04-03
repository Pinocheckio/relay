/**
 * AudioWorkletProcessor — captures microphone audio and converts it to
 * Int16 PCM chunks that are sent back to the main thread via postMessage.
 *
 * Input: Float32 PCM at the browser's native sample rate.
 * The main thread resamples to 16kHz before forwarding to the server.
 */
class PcmProcessor extends AudioWorkletProcessor {
  // Accumulate ~100ms at 16kHz = 1600 samples.
  // AudioWorklet delivers 128 frames at a time, so collect 13 batches (~104ms).
  static get parameterDescriptors() { return []; }

  constructor() {
    super();
    this._buffer = [];
    this._targetChunkSamples = 1600; // 100ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const float32 = input[0];

    // Calculate RMS for level meter
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    const rms = Math.sqrt(sum / float32.length);
    this.port.postMessage({ type: 'level', rms });

    for (let i = 0; i < float32.length; i++) {
      this._buffer.push(float32[i]);
    }

    while (this._buffer.length >= this._targetChunkSamples) {
      const chunk = this._buffer.splice(0, this._targetChunkSamples);
      this.port.postMessage({ type: 'pcm_chunk', samples: new Float32Array(chunk) });
    }

    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
