// Downsamples incoming microphone audio to 24kHz 16-bit PCM for AssemblyAI streaming
class LioraPCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions || {};
    this.ratio = (settings.inputSampleRate || sampleRate) / (settings.targetSampleRate || 24000);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    const length = Math.floor(input.length / this.ratio);
    const pcm = new Int16Array(length);

    // Linear interpolation resampling
    for (let i = 0; i < length; i++) {
      const pos = i * this.ratio;
      const left = Math.floor(pos);
      const right = Math.min(left + 1, input.length - 1);
      const sample = input[left] + (input[right] - input[left]) * (pos - left);
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }

    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("liora-pcm", LioraPCMProcessor);
