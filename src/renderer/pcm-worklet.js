// AudioWorkletProcessor：Float32 → Int16，累积到 4096 样本（16kHz 下 256ms）
// 再 postMessage 一个 Int16Array。
//
// 为什么要攒：worklet 每 128 帧回调一次（16k 下 8ms），逐次 IPC 太碎。
// 为什么是 4096：256ms 一块，3 秒录音 ≈ 11 块，正好是 §21.2 那条可观测判据
// （录 3 秒日志里 PCM 块计数应 ≈ 11±1；为 0 就是 worklet 没被拉起）。
const BATCH = 4096;

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(BATCH);
    this.at = 0;
  }

  flush() {
    if (this.at === 0) return;
    const out = this.buf.slice(0, this.at);
    this.port.postMessage(out, [out.buffer]);
    this.at = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true; // 还没连上源，保持存活
    for (let i = 0; i < ch.length; i += 1) {
      let v = ch[i];
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      this.buf[this.at] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.at += 1;
      if (this.at === BATCH) this.flush();
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
