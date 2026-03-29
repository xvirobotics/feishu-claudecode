/**
 * AudioWorklet processor — captures raw PCM 16kHz 16-bit mono.
 *
 * Runs on the audio thread. Receives audio at the browser's native
 * sample rate (44100/48000 Hz), downsamples to 16000 Hz, converts
 * float32 → int16, and posts ~100ms chunks to the main thread.
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._targetRate = 16000;
    this._ratio = sampleRate / this._targetRate; // e.g. 48000/16000 = 3
    this._buf = [];
    this._idx = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;

    // Point-sample downsample + float32 → int16
    for (let i = 0; i < ch.length; i++) {
      this._idx++;
      if (this._idx >= this._ratio) {
        this._idx -= this._ratio;
        const s = Math.max(-1, Math.min(1, ch[i]));
        this._buf.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      }
    }

    // Post when we have ~100ms (1600 samples at 16kHz)
    if (this._buf.length >= 1600) {
      const pcm = new Int16Array(this._buf);
      this.port.postMessage({ type: 'pcm', samples: pcm.buffer }, [pcm.buffer]);
      this._buf = [];
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
