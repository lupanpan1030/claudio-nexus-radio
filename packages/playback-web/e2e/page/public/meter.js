// Test-only pass-through tap on the master bus. Captures run on the audio
// rendering thread, frame-stamped, bounded to 15 s per capture.
class PcmMeter extends AudioWorkletProcessor {
  capture = null;
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === "capture") {
        if (this.capture) this.finish("replaced");
        this.capture = { id: data.id, remaining: Math.min(Math.ceil(data.seconds * sampleRate), sampleRate * 15), frames: 0, startFrame: null };
      } else if (data.type === "cancel") this.finish("cancelled");
    };
  }
  finish(reason) {
    if (!this.capture) return;
    this.port.postMessage({ kind: "capture-end", id: this.capture.id, reason, sampleRate, frames: this.capture.frames, startFrame: this.capture.startFrame });
    this.capture = null;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let ch = 0; ch < output.length; ch++) {
      output[ch].fill(0);
      if (input[ch]) output[ch].set(input[ch]);
    }
    const cap = this.capture;
    if (cap) {
      if (cap.startFrame === null) cap.startFrame = currentFrame;
      const frames = Math.min(cap.remaining, output[0]?.length || 128);
      const mono = new Float32Array(frames);
      if (input[0]) mono.set(input[0].subarray(0, frames));
      this.port.postMessage({ kind: "capture-chunk", id: cap.id, startFrame: currentFrame, frames, mono }, [mono.buffer]);
      cap.frames += frames;
      cap.remaining -= frames;
      if (cap.remaining <= 0) this.finish("completed");
    }
    return true;
  }
}
registerProcessor("pcm-meter", PcmMeter);
