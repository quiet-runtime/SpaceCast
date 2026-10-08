/* Spectrum and waveform display from the player's WebAudio graph.
 * Connect only after the context runs, and keep the graph alive while X
 * moves the player between native and persistent presentations. */

const SPECTRUM_HEIGHT = 52;
const WAVE_HEIGHT = 24;
const VIEW_GAP = 4;
const TOP_HZ = 24000; // Drawing is also clamped to the context's Nyquist frequency.
const PEAK_FALL = 2.2; // display units per frame, about a two second fall

class AudioVisualizer {
  constructor(audio, equalizer) {
    this.audio = audio;
    this.equalizer = equalizer || null;
    this.context = null;
    this.analyser = null;
    this.frame = 0;
    this.failed = false;
    this.attaching = false;
    this.disposed = false;
    this.renderEnabled = true;
    this.reducedMotion = false;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "ss-visualizer";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Live audio spectrum in violet and waveform in cyan");
    Object.assign(this.canvas.style, {
      display: "block",
      width: "100%",
      height: SPECTRUM_HEIGHT + WAVE_HEIGHT + VIEW_GAP + "px",
      background: "linear-gradient(180deg, rgba(19, 15, 29, 0.75), rgba(4, 4, 8, 0.85))",
      border: "1px solid rgba(189, 147, 249, 0.1)",
      borderRadius: "12px",
      boxSizing: "border-box",
    });
  }

  get element() {
    return this.canvas;
  }

  async attach() {
    if (this.analyser != null || this.failed || this.attaching || this.disposed) return;
    if (typeof AudioContext == "undefined") {
      this.failed = true;
      return;
    }

    this.attaching = true;
    let source = null;
    try {
      if (this.context == null) this.context = new AudioContext();
      const context = this.context;
      if (context.state == "suspended") await context.resume();
      if (this.disposed || this.context !== context) return;
      // Not running yet: leave the audio alone and try again on the next
      // gesture rather than routing it into a stalled context.
      if (context.state != "running") return;

      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.72;
      analyser.minDecibels = -100;
      analyser.maxDecibels = -10;

      // The analyser sits after the equaliser, so the display shows what
      // is actually being heard rather than what arrived.
      // Build optional processing before taking ownership of media playback.
      const chain = this.equalizer?.createChain(context);
      source = context.createMediaElementSource(this.audio);
      let tail = source;
      if (chain) {
        source.connect(chain.head);
        tail = chain.tail;
      }
      tail.connect(analyser);
      analyser.connect(context.destination);

      this.analyser = analyser;
      this.spectrum = new Uint8Array(analyser.frequencyBinCount);
      this.wave = new Uint8Array(analyser.fftSize);
      this.peaks = new Float32Array(analyser.frequencyBinCount);
      this.draw();
    } catch (error) {
      // Once a media source exists, a failed processing chain must still
      // route its audio to the speakers.
      if (source && !this.disposed && this.context) {
        try { source.disconnect(); source.connect(this.context.destination); } catch (_) {}
      }
      console.warn("[spacecast] visualiser unavailable", error);
      this.failed = true;
    } finally {
      this.attaching = false;
    }
  }

  // A second output off the same graph, so a video can carry the audio
  // even when the user declines to share the tab's sound.
  captureAudio() {
    if (this.context == null || this.analyser == null) return null;
    try {
      const destination = this.context.createMediaStreamDestination();
      this.analyser.connect(destination);
      return destination.stream.getAudioTracks()[0] || null;
    } catch (error) {
      return null;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.context != null) {
      this.context.close().catch(() => {});
      this.context = null;
    }
    this.analyser = null;
  }

  setDisplayOptions({ spectrum = true, reducedMotion = false } = {}) {
    if (this.disposed) return;
    this.renderEnabled = spectrum;
    this.reducedMotion = reducedMotion;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    // Changing graphics never disconnects the audio or equalizer graph.
    if (this.renderEnabled && this.analyser) this.draw();
  }

  draw() {
    this.frame = 0;
    if (this.disposed || !this.renderEnabled) return;
    if (!this.reducedMotion) this.frame = requestAnimationFrame(() => this.draw());
    // DOM detachment during navigation does not end the audio session.
    if (!this.canvas.isConnected || document.hidden || this.analyser == null) return;
    if (this.canvas.clientWidth < 1) return;

    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth));
    const height = SPECTRUM_HEIGHT + WAVE_HEIGHT + VIEW_GAP;
    if (this.canvas.width != Math.floor(width * ratio) || this.canvas.height != Math.floor(height * ratio)) {
      this.canvas.width = Math.floor(width * ratio);
      this.canvas.height = Math.floor(height * ratio);
    }

    const paint = this.canvas.getContext("2d");
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint.clearRect(0, 0, width, height);

    this.analyser.getByteFrequencyData(this.spectrum);
    this.analyser.getByteTimeDomainData(this.wave);
    this.paintSpectrum(paint, width);
    this.paintWave(paint, width);
  }

  paintSpectrum(paint, width) {
    const height = SPECTRUM_HEIGHT;
    const nyquist = this.context.sampleRate / 2;
    const bins = Math.max(2, Math.round((this.spectrum.length * Math.min(TOP_HZ, nyquist)) / nyquist));

    paint.strokeStyle = "rgba(189, 147, 249, 0.06)";
    paint.lineWidth = 1;
    paint.beginPath();
    for (let row = 1; row <= 2; row++) {
      const y = Math.round((row / 3) * height) + 0.5;
      paint.moveTo(0, y);
      paint.lineTo(width, y);
    }
    paint.stroke();

    const yOf = (value) => height - (value / 255) * (height - 2) - 1;

    // Spectrum stays driven by the analyser; the soft fill adds depth
    // without inventing motion while a Space is quiet or paused.
    paint.beginPath();
    paint.moveTo(0, height);
    for (let i = 0; i < bins; i++) {
      paint.lineTo((i / (bins - 1)) * width, yOf(this.spectrum[i]));
    }
    paint.lineTo(width, height);
    paint.closePath();
    const fill = paint.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, "rgba(189, 147, 249, 0.4)");
    fill.addColorStop(1, "rgba(189, 147, 249, 0.025)");
    paint.fillStyle = fill;
    paint.fill();

    paint.beginPath();
    for (let i = 0; i < bins; i++) {
      const x = (i / (bins - 1)) * width;
      const y = yOf(this.spectrum[i]);
      i == 0 ? paint.moveTo(x, y) : paint.lineTo(x, y);
    }
    paint.strokeStyle = "#bd93f9";
    paint.lineWidth = 1.15;
    paint.stroke();

    // Peak hold, falling slowly, so brief peaks stay readable.
    paint.beginPath();
    for (let i = 0; i < bins; i++) {
      this.peaks[i] = Math.max(this.spectrum[i], this.peaks[i] - PEAK_FALL);
      const x = (i / (bins - 1)) * width;
      const y = yOf(this.peaks[i]);
      i == 0 ? paint.moveTo(x, y) : paint.lineTo(x, y);
    }
    paint.strokeStyle = "rgba(255, 121, 198, 0.55)";
    paint.lineWidth = 0.8;
    paint.stroke();
  }

  paintWave(paint, width) {
    const top = SPECTRUM_HEIGHT + VIEW_GAP;
    const middle = top + WAVE_HEIGHT / 2;

    paint.strokeStyle = "rgba(139, 233, 253, 0.08)";
    paint.lineWidth = 1;
    paint.beginPath();
    paint.moveTo(0, Math.round(middle) + 0.5);
    paint.lineTo(width, Math.round(middle) + 0.5);
    paint.stroke();

    const step = Math.max(1, Math.floor(this.wave.length / width));
    const yOf = (value) => middle - ((value - 128) / 128) * (WAVE_HEIGHT / 2 - 2);
    const drawWave = () => {
      for (let i = 0; i < this.wave.length; i += step) {
        const x = (i / (this.wave.length - 1)) * width;
        paint.lineTo(x, yOf(this.wave[i]));
      }
      paint.lineTo(width, yOf(this.wave[this.wave.length - 1]));
    };

    paint.beginPath();
    paint.moveTo(0, middle);
    drawWave();
    paint.lineTo(width, middle);
    paint.closePath();
    paint.fillStyle = "rgba(139, 233, 253, 0.09)";
    paint.fill();

    paint.beginPath();
    paint.moveTo(0, yOf(this.wave[0]));
    drawWave();
    paint.strokeStyle = "rgba(139, 233, 253, 0.85)";
    paint.lineWidth = 1.15;
    paint.stroke();
  }
}
