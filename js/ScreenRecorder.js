/* Browser-confirmed video capture of the integrated Space window.
 * Prefer Element Capture; Region Capture falls back to a rectangle, which
 * may include overlapping content. Unconfined whole-tab recording is refused. */

const FRAME_CHECK_MS = 700;
const VIDEO_STORAGE = "spacecast.video";

// Prefer capable profiles for large portrait frames. Probe both HEVC fourCCs
// because browsers do not necessarily accept both container identifiers.
const VIDEO_CODECS = [
  { family: "hevc", codec: "hvc1.1.6.L153.B0", mime: "video/mp4;codecs=hvc1.1.6.L153.B0,mp4a.40.2", label: "HEVC" },
  { family: "hevc", codec: "hev1.1.6.L153.B0", mime: "video/mp4;codecs=hev1.1.6.L153.B0,mp4a.40.2", label: "HEVC" },
  { family: "hevc", codec: "hvc1.1.6.L93.B0", mime: "video/mp4;codecs=hvc1.1.6.L93.B0,mp4a.40.2", label: "HEVC" },
  { family: "hevc", codec: "hev1.1.6.L93.B0", mime: "video/mp4;codecs=hev1.1.6.L93.B0,mp4a.40.2", label: "HEVC" },
  { family: "hevc", codec: "hvc1.1.6.L120.B0", mime: "video/mp4;codecs=hvc1.1.6.L120.B0,mp4a.40.2", label: "HEVC" },
  { family: "hevc", codec: "hev1.1.6.L120.B0", mime: "video/mp4;codecs=hev1.1.6.L120.B0,mp4a.40.2", label: "HEVC" },
  { family: "h264", codec: "avc1.64003C", mime: "video/mp4;codecs=avc1.64003C,mp4a.40.2", label: "H.264" },
  { family: "h264", codec: "avc1.640033", mime: "video/mp4;codecs=avc1.640033,mp4a.40.2", label: "H.264" },
  { family: "h264", codec: "avc1.640028", mime: "video/mp4;codecs=avc1.640028,mp4a.40.2", label: "H.264" },
  { family: "vp9", codec: "vp09.00.10.08", mime: "video/webm;codecs=vp9,opus", label: "VP9" },
  { family: "vp8", codec: "vp8", mime: "video/webm;codecs=vp8,opus", label: "VP8" },
];

// Scale the bitrate with capture area to preserve text and avatar detail.
function bitrateFor(width, height) {
  const pixels = Math.max(1, width * height);
  return Math.min(10000000, Math.max(2500000, Math.round(pixels * 30 * 0.07)));
}

// Filter by MediaRecorder support, keeping the user's codec preference first.
function codecsInPreferenceOrder(preferHevc) {
  const rank = (entry) =>
    entry.family == "hevc" ? (preferHevc ? 0 : 1) : entry.family == "h264" ? (preferHevc ? 1 : 0) : 2;
  return VIDEO_CODECS.slice()
    .sort((a, b) => rank(a) - rank(b))
    .filter((entry) => typeof MediaRecorder == "function" && MediaRecorder.isTypeSupported(entry.mime));
}

async function chooseVideoCodec(width, height, preferHevc) {
  const usable = codecsInPreferenceOrder(preferHevc);
  if (usable.length == 0) return null;

  // Use WebCodecs to check frame dimensions when possible. Its encoder support
  // is independent of MediaRecorder, so an unsupported result is advisory.
  if (typeof VideoEncoder != "undefined" && width > 0 && height > 0) {
    for (const entry of usable) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec: entry.codec,
          width: width,
          height: height,
          framerate: 30,
          bitrate: bitrateFor(width, height),
        });
        if (support.supported === true) return entry;
      } catch (error) {
        /* ask about the next one */
      }
    }
    console.warn("[spacecast] WebCodecs vouched for nothing at " + width + "x" + height + "; trusting MediaRecorder");
  }

  // Most capable profile first, so the fallback is the one most likely to
  // cover an awkward frame size.
  return usable[0];
}

// Availability is determined by the API that performs the recording.
function hevcAvailable() {
  return codecsInPreferenceOrder(true).some((entry) => entry.family == "hevc");
}

// Confirm actual frames after applying a capture restriction. Prefer a track
// processor so a hidden video sink cannot influence the capture resolution.
async function framesArrive(track, ms) {
  if (typeof MediaStreamTrackProcessor == "function") {
    let reader = null;
    try {
      reader = new MediaStreamTrackProcessor({ track: track }).readable.getReader();
      const frame = await Promise.race([reader.read(), sleep(ms).then(() => null)]);
      if (frame != null && frame.value != null) {
        frame.value.close();
        return true;
      }
      return false;
    } catch (error) {
      return false;
    } finally {
      if (reader != null) reader.cancel().catch(() => {});
    }
  }

  const probe = document.createElement("video");
  probe.muted = true;
  probe.playsInline = true;
  Object.assign(probe.style, { position: "fixed", left: "-4px", top: "-4px", width: "2px", height: "2px", opacity: "0" });
  document.body.appendChild(probe);
  let seen = 0;
  try {
    probe.srcObject = new MediaStream([track]);
    await probe.play();
    await sleep(ms);
    seen = probe.videoWidth > 0 ? 1 : 0;
  } catch (error) {
    seen = 0;
  } finally {
    probe.pause();
    probe.srcObject = null;
    probe.remove();
  }
  return seen > 0;
}

// Normalize H.264 input to zero-origin canvas frames, avoiding capture-surface
// crop offsets that some hardware encoders mishandle. HEVC uses the source track.
function normaliseFrames(track) {
  const canvas = document.createElement("canvas");
  const settings = track.getSettings();
  canvas.width = settings.width || 2;
  canvas.height = settings.height || 2;
  const paint = canvas.getContext("2d", { alpha: false, desynchronized: true });

  const output = canvas.captureStream(0);
  const copy = output.getVideoTracks()[0];
  // Feature-detect manual frame requests across browser implementations.
  const askForFrame =
    typeof copy.requestFrame == "function"
      ? () => copy.requestFrame()
      : typeof output.requestFrame == "function"
        ? () => output.requestFrame()
        : () => {};
  const reader = new MediaStreamTrackProcessor({ track: track }).readable.getReader();

  const pump = async () => {
    while (true) {
      let frame;
      try {
        const next = await reader.read();
        if (next.done) break;
        frame = next.value;
      } catch (error) {
        break;
      }
      if (frame == null) break;
      try {
        if (canvas.width != frame.displayWidth || canvas.height != frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        paint.drawImage(frame, 0, 0);
        askForFrame();
      } catch (error) {
        /* one dropped frame is not worth ending the recording over */
      } finally {
        frame.close();
      }
    }
  };
  pump();

  return { track: copy, stop: () => reader.cancel().catch(() => {}) };
}

class ScreenRecorder {
  constructor(options) {
    this.targetOf = options.targetOf;
    this.audioTrackOf = options.audioTrackOf || (() => null);
    this.nameOf = options.nameOf;
    this.onchange = options.onchange || (() => {});

    this.state = "idle"; // idle | starting | recording | saving
    this.framing = "";
    this.codec = "";
    this.size = "";
    this.preferHevc = false;
    this.hevcSupported = false;
    this.startedAt = 0;
    this.bytes = 0;
    this.fileName = "";
    this.message = "";
    this.chunks = [];
    this.stream = null;
    this.recorder = null;
    this.isolated = null;
    this.restrictedTarget = null;
    this.normaliser = null;

    this.restore();
    // Resolve the visible codec choices before rendering.
    this.hevcSupported = hevcAvailable();
    if (!this.hevcSupported) this.preferHevc = false;
    else if (!this.chosen) this.preferHevc = true;

    if (ScreenRecorder.canCapture && !ScreenRecorder.canFrameElement) {
      console.log(
        "[spacecast] video capture hidden: this browser has neither Element Capture nor " +
          "Region Capture, so a recording could not be confined to the Space"
      );
    }

  }

  static get supported() {
    return (
      ScreenRecorder.canCapture &&
      // Only offer capture when the browser can confine it to the Space.
      ScreenRecorder.canFrameElement
    );
  }

  static get canCapture() {
    return (
      typeof MediaRecorder == "function" &&
      typeof navigator != "undefined" &&
      navigator.mediaDevices != null &&
      typeof navigator.mediaDevices.getDisplayMedia == "function"
    );
  }

  static get canFrameElement() {
    return typeof RestrictionTarget != "undefined" || typeof CropTarget != "undefined";
  }

  get seconds() {
    return this.startedAt == 0 ? 0 : (Date.now() - this.startedAt) / 1000;
  }

  setPreferHevc(prefer) {
    this.preferHevc = prefer && this.hevcSupported;
    this.chosen = true; // an explicit pick outranks the default from here on
    this.save();
    this.onchange();
  }

  save() {
    try {
      localStorage.setItem(VIDEO_STORAGE, JSON.stringify({ hevc: this.preferHevc, chosen: this.chosen }));
    } catch (error) {
      /* the choice just will not stick */
    }
  }

  restore() {
    this.chosen = false;
    try {
      const saved = JSON.parse(localStorage.getItem(VIDEO_STORAGE) || "null");
      if (saved == null) return;
      this.chosen = saved.chosen === true;
      this.preferHevc = this.chosen && saved.hevc === true;
    } catch (error) {
      this.preferHevc = false;
    }
  }

  async start() {
    if (this.state != "idle") return;
    this.message = "";
    this.chunks = [];
    this.bytes = 0;
    this.restrictedTarget = null;
    this.state = "starting";
    this.onchange();

    // Asked for twice if need be. The hints after `video` and `audio` are
    // all optional refinements, and a browser that dislikes one of them
    // rejects the whole call — so a refusal is retried with the bare
    // request before being reported as a failure.
    const wanted = {
      video: { frameRate: 30 },
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
      systemAudio: "exclude",
    };

    let stream = null;
    let refusal = null;
    for (const request of [wanted, { video: true, audio: true }]) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(request);
        break;
      } catch (error) {
        refusal = error;
        // A cancelled picker is a decision, not a fault: do not ask again.
        if (error != null && (error.name == "NotAllowedError" || error.name == "AbortError")) break;
      }
    }

    if (stream == null) {
      const name = (refusal && refusal.name) || "Error";
      const detail = (refusal && refusal.message) || "";
      this.state = "idle";
      this.message =
        name == "NotAllowedError" || name == "AbortError" ? "capture cancelled" : "capture failed: " + name;
      // Named rather than stringified: "[object DOMException]" says nothing.
      if (name != "NotAllowedError" && name != "AbortError") {
        console.warn("[spacecast] display capture refused — " + name + ": " + detail);
      }
      this.onchange();
      return;
    }

    this.stream = stream;
    try {
      const video = stream.getVideoTracks()[0];
      await this.ensureCurrentTarget(video);

      // Tab audio if the user left it on; otherwise tap the player's own
      // graph, so a video is never silent just because the box was unticked.
      if (stream.getAudioTracks().length == 0) {
        const fallback = this.audioTrackOf();
        if (fallback != null) stream.addTrack(fallback);
      }

      // Only now is the frame size known, and the frame size is what decides
      // which codecs can actually encode it.
      const settings = video == null ? {} : video.getSettings();
      const width = settings.width || 0;
      const height = settings.height || 0;
      this.size = width > 0 ? width + "x" + height : "";

      const chosen = await chooseVideoCodec(width, height, this.preferHevc);
      this.codec = chosen == null ? "VP8" : chosen.label;
      if (chosen == null) console.warn("[spacecast] nothing reported support for " + this.size);

      // Use an explicit WebM container when no preferred profile is available.
      const options = {
        mimeType: chosen == null ? "video/webm" : chosen.mime,
        videoBitsPerSecond: bitrateFor(width, height),
      };

      // Codec checks can await the GPU while X replaces the native popup.
      // Reframe the current Space before constructing the recording pipeline.
      await this.ensureCurrentTarget(video);

      // H.264 gets the frames copied through a canvas first; see the note on
      // normaliseFrames. Anything else records the capture track directly.
      let recorded = stream;
      if (chosen != null && chosen.family == "h264" && typeof MediaStreamTrackProcessor == "function" && video != null) {
        try {
          this.normaliser = normaliseFrames(video);
          recorded = new MediaStream([this.normaliser.track, ...stream.getAudioTracks()]);
          this.framing += " (copied)";
        } catch (error) {
          console.warn("[spacecast] could not copy frames through a canvas", error);
          this.normaliser = null;
        }
      }

      this.recorder = new MediaRecorder(recorded, options);
      this.recorder.ondataavailable = (event) => {
        if (event.data != null && event.data.size > 0) {
          this.chunks.push(event.data);
          this.bytes += event.data.size;
        }
      };
      this.recorder.onstop = () => this.write();
      if (!this.hasCurrentTarget()) throw new Error("The Space window moved before video could start. Try recording again.");
      this.recorder.start(1000);

      // Chrome's own "Stop sharing" button ends the track behind our back.
      if (video != null) video.addEventListener("ended", () => this.stop());

      this.state = "recording";
      this.startedAt = Date.now();
      if (this.framing == "no picture") this.message = "no picture — audio only";
      this.onchange();
    } catch (error) {
      // Permission can succeed before the encoder or the audio graph fails.
      // Do not leave capture running or the window waiting forever in "starting".
      if (this.recorder != null) {
        this.recorder.onstop = null;
        this.recorder.ondataavailable = null;
        try { if (this.recorder.state !== "inactive") this.recorder.stop(); } catch {}
      }
      if (this.normaliser != null) {
        try { this.normaliser.stop(); } catch {}
        try { this.normaliser.track.stop(); } catch {}
        this.normaliser = null;
      }
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch {}
      }
      this.releaseIsolation();
      this.restrictedTarget = null;
      this.stream = null;
      this.recorder = null;
      this.chunks = [];
      this.bytes = 0;
      this.startedAt = 0;
      this.state = "idle";
      this.message = "capture failed: " + (error?.message || error?.name || "encoder unavailable");
      console.warn("[spacecast] video startup failed", error);
      this.onchange();
    }
  }

  hasCurrentTarget() {
    const target = this.targetOf();
    return !!target?.isConnected && target === this.restrictedTarget && /^(element|region)(?:$| )/.test(this.framing);
  }

  async ensureCurrentTarget(video) {
    if (!video) throw new Error("No video track was provided by the browser");
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = this.targetOf();
      if (!target?.isConnected) throw new Error("The Space window is unavailable. Try recording again.");
      if (this.hasCurrentTarget()) return;
      try { await this.restrict(video, target); }
      catch (error) {
        if (target !== this.targetOf() || !target.isConnected) continue;
        throw error;
      }
      if (this.hasCurrentTarget()) return;
    }
    throw new Error("The Space window kept moving during video setup. Try recording again.");
  }

  // Element Capture needs its target to form a stacking context, so one is
  // forced on for the duration and the old value put back afterwards.
  // Isolation neither moves nor clips anything, so the sheet looks the same
  // while it is on.
  async restrict(video, target = this.targetOf()) {
    this.restrictedTarget = null;
    this.releaseIsolation();
    const current = () => target?.isConnected && target === this.targetOf();
    if (!video || !current()) throw new Error("The Space window is unavailable. Try recording again.");

    if (typeof RestrictionTarget != "undefined" && video.restrictTo != null) {
      try {
        this.isolated = { element: target, previous: target.style.isolation };
        target.style.isolation = "isolate";
        const token = await RestrictionTarget.fromElement(target);
        if (!current()) throw new Error("The Space window moved during video setup");
        await video.restrictTo(token);
        const framed = await framesArrive(video, FRAME_CHECK_MS);
        if (!current()) throw new Error("The Space window moved during video setup");
        if (framed) {
          this.framing = "element";
          this.restrictedTarget = target;
          return;
        }
        console.warn("[spacecast] element capture produced no frames, cropping instead");
        await video.restrictTo(null);
      } catch (error) {
        if (current()) console.warn("[spacecast] element capture unavailable", error);
      }
      this.releaseIsolation();
      if (!current()) throw new Error("The Space window moved during video setup");
    }

    if (typeof CropTarget != "undefined" && video.cropTo != null) {
      try {
        const token = await CropTarget.fromElement(target);
        if (!current()) throw new Error("The Space window moved during video setup");
        await video.cropTo(token);
        const framed = await framesArrive(video, FRAME_CHECK_MS);
        if (!current()) throw new Error("The Space window moved during video setup");
        if (framed) {
          this.framing = "region";
          this.restrictedTarget = target;
          return;
        }
        console.warn("[spacecast] region capture produced no frames");
        await video.cropTo(null);
      } catch (error) {
        if (current()) console.warn("[spacecast] region capture unavailable", error);
      }
    }

    // A Space recording must never silently widen to the page being browsed.
    throw new Error("The browser could not frame this Space. Try recording again.");
  }

  releaseIsolation() {
    if (this.isolated == null) return;
    this.isolated.element.style.isolation = this.isolated.previous;
    this.isolated = null;
  }

  stop() {
    if (this.state != "recording") return;
    this.state = "saving";
    this.onchange();
    try {
      this.recorder.stop(); // write() runs from onstop
    } catch (error) {
      this.write();
    }
  }

  write() {
    if (this.normaliser != null) {
      this.normaliser.stop();
      this.normaliser.track.stop();
      this.normaliser = null;
    }
    for (const track of this.stream == null ? [] : this.stream.getTracks()) track.stop();
    this.releaseIsolation();
    this.restrictedTarget = null;
    this.stream = null;

    if (this.chunks.length == 0) {
      this.state = "idle";
      this.message = "nothing captured";
      this.onchange();
      return;
    }

    const type = (this.recorder && this.recorder.mimeType) || "video/webm";
    const blob = new Blob(this.chunks, { type: type });
    this.chunks = [];
    this.bytes = blob.size;
    this.fileName = this.nameOf(type.indexOf("mp4") >= 0 ? "mp4" : "webm");

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = this.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);

    this.state = "idle";
    this.startedAt = 0;
    this.message = "video saved";
    this.onchange();
  }
}
