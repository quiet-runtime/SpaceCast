/* ------------------------------------------------------------------ *
 * Recording
 *
 * The recorder polls the HLS playlist itself and takes the audio
 * segments directly, instead of recording what the <audio> element
 * plays. That keeps working while the tab is muted or paused, and
 * lets a finished Space (whose playlist carries #EXT-X-ENDLIST) be
 * pulled down in full, faster than real time.
 *
 * Segments are handed to the Opus transcoder as they arrive, so the
 * .opus file is essentially ready by the time recording stops. The
 * raw segments are kept as well, purely as a fallback for the case
 * where transcoding is unavailable or fails.
 * ------------------------------------------------------------------ */

const CONTAINERS = {
  aac: { ext: "aac", mime: "audio/aac" },
  ts: { ext: "ts", mime: "video/mp2t" },
  mp4: { ext: "m4a", mime: "audio/mp4" },
};

// How far back before the *listener's* position to keep the stream on
// hand, so pressing Record captures the moment that prompted it.
//
// Playback runs well behind the live edge: hls.js holds three target
// durations back by default, which is around ten seconds on a Space. So
// the buffer has to cover that lag as well, or "the last ten seconds"
// turns out to be ten seconds the listener has not reached yet.
const PREROLL_SECONDS = 10;
const PREROLL_MAX_SECONDS = 120;

// How far the playhead trails the newest audio the player holds.
function playbackLag(audio) {
  if (audio == null) return 0;
  try {
    let edge = 0;
    for (const ranges of [audio.seekable, audio.buffered]) {
      if (ranges != null && ranges.length > 0) edge = Math.max(edge, ranges.end(ranges.length - 1));
    }
    const lag = edge - audio.currentTime;
    return isFinite(lag) && lag > 0 ? lag : 0;
  } catch (error) {
    return 0; // the element is not ready to be asked yet
  }
}

function absoluteUrl(uri, base) {
  return new URL(uri, base).toString();
}

function guessContainer(segmentUrl) {
  const path = new URL(segmentUrl).pathname.toLowerCase();
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".mp4") || path.endsWith(".m4s") || path.endsWith(".m4a")) return "mp4";
  return "aac";
}

function parsePlaylist(text, baseUrl) {
  const result = { segments: [], endList: false, targetDuration: 0, map: null, variant: null };
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let duration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line == "") continue;

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      // Master playlist: hand back the first variant and re-enter with it.
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] != "" && !lines[j].startsWith("#")) {
          result.variant = absoluteUrl(lines[j], baseUrl);
          break;
        }
      }
      return result;
    }

    if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      result.targetDuration = parseFloat(line.split(":")[1]) || 0;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      result.endList = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const match = /URI="([^"]+)"/.exec(line);
      if (match != null) result.map = absoluteUrl(match[1], baseUrl);
    } else if (!line.startsWith("#")) {
      result.segments.push({
        url: absoluteUrl(line, baseUrl),
        duration: duration || result.targetDuration || 3,
      });
      duration = 0;
    }
  }
  return result;
}

const STREAM_REQUEST_TIMEOUT = 15000;

// Bound the complete response, including its body. The explicit race also
// settles if a browser transport does not finish promptly after abort().
async function fetchStreamResource(url, body, signal, label) {
  const controller = new AbortController();
  let timeout;
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => {
      const error = signal?.reason || new DOMException("Recording stopped", "AbortError");
      controller.abort(error);
      reject(error);
    };
    if (signal?.aborted) abort();
    else {
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => {
        const error = new Error(label + " request timed out");
        error.name = "TimeoutError";
        controller.abort(error);
        reject(error);
      }, STREAM_REQUEST_TIMEOUT);
    }
  });
  const request = Promise.resolve().then(async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetch(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!response.ok) throw new Error(label + " HTTP " + response.status);
    return await response[body]();
  });
  try { return await Promise.race([request, interrupted]); }
  finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function waitForStream(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function fetchSegment(url, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return null;
    try {
      return new Uint8Array(await fetchStreamResource(url, "arrayBuffer", signal, "Segment"));
    } catch (error) {
      if (signal?.aborted) return null;
      if (attempt == 2) {
        console.warn("[spacecast] dropped segment", url, error);
        return null;
      }
      await waitForStream(400 * (attempt + 1), signal);
    }
  }
  return null;
}

/* --------------------------- pre-roll ------------------------------- */

// Keeps the tail of a live stream on hand so that pressing Record also
// captures the seconds just before it was pressed. Only live streams are
// buffered: a finished Space is downloaded from its own beginning anyway,
// so there is nothing to catch up on.
class PreRoll {
  constructor(playlistUrl, isActive, lagOf) {
    this.playlistUrl = playlistUrl;
    this.isActive = isActive;
    this.lagOf = lagOf || (() => 0);
    this.seen = new Set();
    this.segments = [];
    this.seconds = 0;
    this.retain = PREROLL_SECONDS;
    this.lag = 0;
    this.live = null; // null while unknown
    this.running = false;
    this.requestController = null;
    this.onchange = () => {};
  }

  // Enough to reach PREROLL_SECONDS behind the playhead, and never less
  // than the playlist window, which recording would have picked up anyway.
  windowToKeep(playlist) {
    this.lag = this.lagOf();
    const window = playlist.segments.reduce((total, segment) => total + segment.duration, 0);
    return Math.min(PREROLL_MAX_SECONDS, Math.max(PREROLL_SECONDS + this.lag, window));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.requestController = new AbortController();
    this.loop();
  }

  stop() {
    this.running = false;
    this.requestController?.abort();
  }

  // Hands the buffer to a recorder. Every URL ever seen goes with it, not
  // just the retained ones, so the recorder does not re-fetch segments
  // that have already aged out and append them out of order.
  take() {
    return { seen: new Set(this.seen), segments: this.segments.slice(), seconds: this.seconds };
  }

  async loop() {
    let url = this.playlistUrl;
    const signal = this.requestController.signal;
    while (this.running && !signal.aborted) {
      if (!this.isActive()) {
        this.running = false;
        return;
      }

      let playlist;
      try {
        playlist = parsePlaylist(await fetchStreamResource(url, "text", signal, "Playlist"), url);
      } catch (error) {
        if (signal.aborted) return;
        await waitForStream(1000, signal);
        continue;
      }

      if (playlist.variant != null) {
        url = playlist.variant;
        continue;
      }
      if (playlist.endList) {
        this.live = false;
        this.running = false;
        this.onchange();
        return;
      }
      this.live = true;

      for (const segment of playlist.segments) {
        if (!this.running || signal.aborted) return;
        if (this.seen.has(segment.url)) continue;
        const bytes = await fetchSegment(segment.url, signal);
        if (bytes == null || !this.running || signal.aborted) continue;
        this.seen.add(segment.url);
        this.segments.push({ url: segment.url, duration: segment.duration, bytes: bytes });
        this.seconds += segment.duration;
      }

      // Drop from the front while the remainder still covers the window.
      this.retain = this.windowToKeep(playlist);
      while (this.segments.length > 1 && this.seconds - this.segments[0].duration >= this.retain) {
        this.seconds -= this.segments[0].duration;
        this.segments.shift();
      }

      if (!this.running || signal.aborted) return;
      this.onchange();
      await waitForStream(Math.min(6000, Math.max(1000, (playlist.targetDuration || 3) * 1000)), signal);
    }
  }
}

/* --------------------------- recorder ------------------------------- */

const activeRecorders = new Set();

class SpaceRecorder {
  constructor(playlistUrl, space) {
    this.playlistUrl = playlistUrl;
    this.space = { ...space };
    this.state = "idle"; // idle | recording | encoding | saving | done | error
    this.seen = new Set();
    this.chunks = [];
    this.initSegment = null;
    this.container = null;
    this.transcoder = null;
    this.transcodable = true;
    this.bytes = 0; // of the part being captured now
    this.totalBytes = 0;
    this.capturedSeconds = 0;
    this.prerollSeconds = 0;
    this.totalSeconds = 0; // known only once #EXT-X-ENDLIST is seen
    this.endList = false;
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.part = 1;
    this.parts = []; // file names already written by Eject
    this.fileName = "";
    this.message = "";
    this.stopRequested = false;
    this.requestController = new AbortController();
    this.ejectRequested = false;
    this.ejecting = false;
    this.onchange = () => {};
  }

  get paused() {
    return this.pausedAt != 0;
  }

  // For a live Space the wall clock ticks smoothly and matches the audio;
  // for a replay being pulled down at speed, only the captured duration
  // means anything.
  get seconds() {
    if (this.endList) return this.capturedSeconds;
    if (this.startedAt == 0) return 0;
    const now = this.stoppedAt || Date.now();
    const paused = this.pausedTotal + (this.pausedAt != 0 ? now - this.pausedAt : 0);
    return this.prerollSeconds + Math.max(0, now - this.startedAt - paused) / 1000;
  }

  async start(preroll) {
    if (this.state != "idle") return;
    this.state = "recording";
    this.startedAt = Date.now();
    activeRecorders.add(this);
    this.onchange();

    try {
      let claimed = [];
      if (preroll != null) {
        this.adopt(preroll);
        claimed = await this.claim();
        await this.replay(preroll);
      }
      if (claimed.length > 0) await this.download(claimed, 4);
      await this.pump();
    } catch (error) {
      console.error("[spacecast] recording stopped", error);
      this.message = String(error.message || error);
    }
    try { await this.finish(); }
    finally { activeRecorders.delete(this); }
  }

  // Take over the pre-roll's bookkeeping. This has to happen before the
  // playlist is read, so segments the buffer already holds are not fetched
  // a second time and appended after it, out of order.
  adopt(preroll) {
    for (const url of preroll.seen) this.seen.add(url);
    this.prerollSeconds = preroll.seconds;
    this.capturedSeconds = preroll.seconds;
    if (preroll.segments.length > 0) this.container = guessContainer(preroll.segments[0].url);
  }

  // Claim everything the playlist is offering right now, before handing
  // the buffer to the encoder. Whatever that costs, the live window cannot
  // slide past us in the meantime and leave a hole in the recording.
  async claim() {
    for (let hop = 0; hop < 3; hop++) {
      let playlist;
      try {
        playlist = parsePlaylist(await this.fetchText(this.playlistUrl), this.playlistUrl);
      } catch (error) {
        return []; // pump() will pick things up on its next poll
      }
      if (playlist.variant != null) {
        this.playlistUrl = playlist.variant;
        continue;
      }
      if (playlist.map != null && this.initSegment == null) {
        this.container = "mp4";
        this.initSegment = await fetchSegment(playlist.map, this.requestController.signal);
      }
      const fresh = playlist.segments.filter((segment) => !this.seen.has(segment.url));
      fresh.forEach((segment) => this.seen.add(segment.url));
      if (this.container == null && fresh.length > 0) this.container = guessContainer(fresh[0].url);
      return fresh;
    }
    return [];
  }

  // Hand the buffered audio to the encoder, oldest first.
  async replay(preroll) {
    for (const segment of preroll.segments) {
      this.chunks.push(segment.bytes);
      this.bytes += segment.bytes.byteLength;
      this.totalBytes += segment.bytes.byteLength;
      await this.transcode(segment.bytes);
    }
    this.onchange();
  }

  requestStop() {
    this.stopRequested = true;
    this.requestController.abort();
    this.onchange();
  }

  // Handled at a poll boundary rather than here, so the split never lands
  // in the middle of a segment being pushed into the encoder.
  requestEject() {
    if (this.state != "recording" || this.bytes == 0) return;
    if (this.ejectRequested || this.ejecting || this.stopRequested) return;
    this.ejectRequested = true;
    this.onchange();
  }

  // Write out what has been captured so far and keep rolling. An encoder
  // cannot be cut mid-stream, so the current one is finished off and a
  // fresh one takes over; audio from here lands in the next part.
  async eject() {
    this.ejectRequested = false;
    this.ejecting = true;
    this.onchange();

    const transcoder = this.transcoder;
    const chunks = this.chunks;
    const initSegment = this.initSegment;
    const part = this.part;

    this.transcoder = null;
    this.chunks = [];
    this.bytes = 0;
    this.part += 1;

    try {
      // Ejecting means more is coming, so this part is numbered from the off.
      const written = await this.writeFile(transcoder, chunks, initSegment, part, true);
      this.parts.push(written);
    } catch (error) {
      console.error("[spacecast] could not write part " + part, error);
      this.message = "part " + part + " failed to save";
    }
    this.ejecting = false;
    this.onchange();
  }

  setPaused(paused) {
    if (this.state != "recording" || this.paused == paused) return;
    if (paused) {
      this.pausedAt = Date.now();
    } else {
      this.pausedTotal += Date.now() - this.pausedAt;
      this.pausedAt = 0;
    }
    this.onchange();
  }

  async pump() {
    let url = this.playlistUrl;
    let targetDuration = 3;
    let playlistFailures = 0;

    while (!this.stopRequested) {
      let playlist;
      try {
        playlist = parsePlaylist(await this.fetchText(url), url);
        playlistFailures = 0;
      } catch (error) {
        if (this.stopRequested) return;
        // A live Space that has just ended stops serving its playlist.
        if (++playlistFailures >= 4) {
          this.message = this.bytes > 0 ? "stream ended" : String(error.message || error);
          return;
        }
        await this.interruptibleSleep(1000);
        continue;
      }

      if (playlist.variant != null) {
        url = playlist.variant;
        continue;
      }
      if (playlist.targetDuration > 0) targetDuration = playlist.targetDuration;

      if (playlist.endList && !this.endList) {
        this.endList = true;
        this.totalSeconds = playlist.segments.reduce((total, segment) => total + segment.duration, 0);
      }

      if (playlist.map != null && this.initSegment == null) {
        this.container = "mp4";
        this.initSegment = await fetchSegment(playlist.map, this.requestController.signal);
      }

      const fresh = playlist.segments.filter((segment) => !this.seen.has(segment.url));
      fresh.forEach((segment) => this.seen.add(segment.url));

      // While paused, segments are marked as seen but never fetched, so
      // resuming continues from the present rather than backfilling.
      if (!this.paused) {
        if (this.container == null && fresh.length > 0) this.container = guessContainer(fresh[0].url);
        await this.download(fresh, playlist.endList ? 6 : 2);
      }

      if (this.stopRequested) return;
      if (playlist.endList) {
        this.message = "complete";
        return;
      }
      if (this.ejectRequested) await this.eject();
      await this.interruptibleSleep(Math.min(6000, Math.max(1000, targetDuration * 1000)));
    }
  }

  async download(segments, concurrency) {
    if (segments.length == 0) return;

    const buffers = new Array(segments.length);
    let cursor = 0;
    const worker = async () => {
      while (!this.stopRequested) {
        const index = cursor++;
        if (index >= segments.length) return;
        const buffer = await fetchSegment(segments[index].url, this.requestController.signal);
        if (buffer != null) {
          buffers[index] = buffer;
          this.bytes += buffer.byteLength;
          this.totalBytes += buffer.byteLength;
          this.capturedSeconds += segments[index].duration;
          this.onchange();
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()));

    for (const buffer of buffers) {
      if (buffer == null) continue;
      this.chunks.push(buffer);
      await this.transcode(buffer);
    }
    this.onchange();
  }

  // Feed a segment to the Opus encoder as soon as it lands. Only a plain
  // ADTS stream can be pushed through incrementally; anything else is
  // converted in one pass at the end, from the segments kept in memory.
  async transcode(buffer) {
    if (!this.transcodable) return;

    if (this.transcoder == null) {
      if (this.container != "aac" || !(await OpusTranscoder.isSupportedForAac())) {
        this.transcodable = false;
        return;
      }
      this.transcoder = new OpusTranscoder();
      await this.transcoder.start();
    }

    try {
      await this.transcoder.pushAac(buffer);
    } catch (error) {
      console.warn("[spacecast] live transcode failed, falling back", error);
      this.transcodable = false;
      this.transcoder = null;
    }
  }

  async fetchText(url) {
    return await fetchStreamResource(url, "text", this.requestController.signal, "Playlist");
  }

  async interruptibleSleep(ms) {
    await waitForStream(ms, this.requestController.signal);
  }

  async finish() {
    this.stoppedAt = Date.now();
    this.pausedAt = 0;
    this.ejectRequested = false;
    while (this.ejecting) await sleep(100); // let a part in flight land first

    if (this.totalBytes == 0) {
      this.state = "error";
      if (this.message == "") this.message = "nothing captured";
      this.onchange();
      return;
    }
    if (this.bytes == 0) {
      // Everything already went out through Eject, on the nose.
      this.state = "done";
      this.onchange();
      return;
    }

    this.state = "encoding";
    this.onchange();

    try {
      const written = await this.writeFile(
        this.transcoder, this.chunks, this.initSegment, this.part, this.part > 1
      );
      this.fileName = written.name;
      this.bytes = written.size;
      if (this.part > 1) this.parts.push(written);
    } catch (error) {
      console.error("[spacecast] could not write the recording", error);
      this.state = "error";
      this.message = String(error.message || error);
      this.onchange();
      return;
    }

    this.state = "done";
    this.onchange();
  }

  // Turn one part's worth of audio into a file and hand it to the browser.
  // Eject and Stop both come through here; the only difference is whether
  // recording carries on afterwards.
  async writeFile(transcoder, chunks, initSegment, part, numbered) {
    const when = new Date(this.startedAt || Date.now());

    let blob = null;
    let extension = "opus";
    try {
      blob = await this.toOpus(transcoder, chunks, initSegment, buildTags(this.space, when, numbered ? part : 0));
    } catch (error) {
      console.warn("[spacecast] Opus encoding failed, saving the raw stream", error);
      this.message = "raw stream, Opus unavailable";
    }

    if (blob == null) {
      const container = CONTAINERS[this.container || "aac"];
      const pieces = initSegment != null ? [initSegment, ...chunks] : chunks;
      blob = new Blob(pieces, { type: container.mime });
      extension = container.ext;
    }

    const name = buildFileName(this.space, extension, when, numbered ? part : 0);
    if (this.state == "encoding") {
      this.state = "saving";
      this.onchange();
    }

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);

    return { name: name, size: blob.size };
  }

  // Ogg Opus at 48 kHz; preserve mono or stereo source channels.
  async toOpus(transcoder, chunks, initSegment, comments) {
    if (transcoder != null) return await transcoder.finish(comments);
    if (!(await OpusTranscoder.isSupported())) return null;

    const pieces = initSegment != null ? [initSegment, ...chunks] : chunks;
    return await transcodeBufferToOpus(await new Blob(pieces).arrayBuffer(), comments);
  }
}

// Ask the browser to confirm navigation while a recording is in progress.
window.addEventListener("beforeunload", (event) => {
  for (const recorder of activeRecorders) {
    if (["recording", "encoding", "saving", "starting"].includes(recorder.state)) {
      event.preventDefault();
      event.returnValue = "";
      return;
    }
  }
});

/* --------------------------- naming --------------------------------- */

function readSpace(response, spaceId) {
  const metadata = response?.data?.audioSpace?.metadata || {};
  const creator = metadata.creator_results?.result || {};
  return {
    id: spaceId,
    url: "https://x.com/i/spaces/" + spaceId,
    title: metadata.title || "",
    host: creator.core?.name || creator.legacy?.name || creator.core?.screen_name || creator.legacy?.screen_name || "",
    startedAt: metadata.started_at || metadata.created_at || 0,
    scheduledStart: metadata.scheduled_start || 0,
    state: metadata.state || "",
  };
}

function recordingText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/gu, " ").trim();
}

function slugify(text, maxBytes = 120) {
  const safe = recordingText(text).replace(/[^\p{L}\p{M}\p{N}\u200C\u200D]+/gu, "-");
  const encoder = new TextEncoder();
  let result = "", bytes = 0, characters = 0;
  for (const character of safe) {
    const size = encoder.encode(character).length;
    if (bytes + size > maxBytes || characters >= 60) break;
    result += character;
    bytes += size;
    characters++;
  }
  return result.replace(/^[\p{M}\u200C\u200D-]+|[-\u200C\u200D]+$/gu, "");
}

function recordingDate(when) {
  const pad = (value) => String(value).padStart(2, "0");
  return when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate());
}

function buildFileName(space, extension, when, part) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = recordingDate(when) + "_" + pad(when.getHours()) + pad(when.getMinutes()) + pad(when.getSeconds());

  const parts = [];
  const title = slugify(space.title || "");
  if (title != "") parts.push(title);
  parts.push(slugify(space.id, 48) || "space");
  parts.push(stamp);
  if (part > 0) parts.push("pt" + part);
  return parts.join("_") + "." + extension;
}

// Vorbis comments, so the Space and its link travel inside the file even
// once it has been renamed or moved somewhere else.
function buildTags(space, when, part) {
  const title = recordingText(space.title) || ("X Space " + recordingText(space.id)).trim();
  const host = recordingText(space.host);
  const comments = ["TITLE=" + title];
  if (host) comments.push("ARTIST=" + host);
  comments.push("DATE=" + recordingDate(when));
  if (part > 0) comments.push("TRACKNUMBER=" + part);
  const url = recordingText(space.url);
  if (url) comments.push("DESCRIPTION=" + url);
  comments.push("ENCODER=" + PRODUCT_NAME);
  return comments;
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

const SPACECAST_AUDIO_ID = "spacecast-audio";

function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const pad = (value) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  return (
    (hours > 0 ? hours + ":" : "") + pad(Math.floor((total % 3600) / 60)) + ":" + pad(total % 60)
  );
}

// Show elapsed Space age at minute granularity.
function formatAge(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return hours + "h " + String(minutes).padStart(2, "0") + "m";
  if (minutes > 0) return minutes + "m";
  return total + "s";
}

// Space age is independent of the player's available rewind window.
function describeSpace(space, now) {
  if (space.state == "Ended") return "ended";
  if (space.state == "NotStarted" || space.state == "Scheduled") {
    return space.scheduledStart > now ? "starts in " + formatAge(space.scheduledStart - now) : "not started";
  }
  if (space.startedAt > 0) return "live " + formatAge(now - space.startedAt);
  return "";
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function pillButton(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ss-button";
  button.textContent = text;
  return button;
}

/* --------------------------- controls -------------------------------- */

const BLINK_CLASS = "spacecast-rec-pulse";
const STYLE_ID = "spacecast-styles";

// Prefer the host page's loaded font, with system fallbacks.
const UI_FONT =
  '"TwitterChirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

function installStyles() {
  const root = document.head || document.documentElement;
  if (root == null || document.getElementById(STYLE_ID) != null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    "@keyframes " + BLINK_CLASS + " { 0%, 100% { opacity: 1 } 50% { opacity: 0.1 } }" +
    "." + BLINK_CLASS + " { animation: " + BLINK_CLASS + " 1.2s ease-in-out infinite }" +
    "@media (prefers-reduced-motion: reduce) { ." + BLINK_CLASS + " { animation: none } }";
  root.appendChild(style);
}

// Built node by node rather than through innerHTML, which is a guarded
// sink on pages that turn on Trusted Types.
const SVG_NS = "http://www.w3.org/2000/svg";

function transportIcon(shapes) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const shape of shapes) {
    const node = document.createElementNS(SVG_NS, shape.tag);
    for (const name of Object.keys(shape)) {
      if (name != "tag") node.setAttribute(name, shape[name]);
    }
    svg.appendChild(node);
  }
  return svg;
}

// Tape transport glyphs: two bars, a triangle, a square.
const PAUSE_ICON = [
  { tag: "rect", x: 7, y: 5, width: 3.5, height: 14, rx: 1 },
  { tag: "rect", x: 13.5, y: 5, width: 3.5, height: 14, rx: 1 },
];
const PLAY_ICON = [{ tag: "path", d: "M8 5.2v13.6L19 12z" }];
const STOP_ICON = [{ tag: "rect", x: 5.5, y: 5.5, width: 13, height: 13, rx: 1.5 }];
const VIDEO_ICON = [
  { tag: "rect", x: 2.5, y: 6.5, width: 12.5, height: 11, rx: 2.5 },
  { tag: "path", d: "M16.5 12l5-3.6v7.2z" },
];
const EJECT_ICON = [
  { tag: "path", d: "M12 4.5 20 14H4z" },
  { tag: "rect", x: 4, y: 16, width: 16, height: 3.5, rx: 1.2 },
];

function transportButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ss-icon-button ss-record-transport";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.style.display = "none";
  return button;
}

// The record button becomes a status indicator while recording is active.
function recBadge() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ss-record";
  const dot = document.createElement("span");
  dot.className = "ss-record-dot";
  const label = document.createElement("span");
  label.textContent = "Record audio";
  button.append(dot, label);
  return { button, dot, label };
}

function createPanel(space) {
  const panel = document.createElement("div");
  panel.id = "spacecast-panel";
  panel.className = "ss-player";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "SpaceCast player and recorder");
  panel.dir = "ltr";

  const header = document.createElement("div");
  header.className = "ss-brand-row";
  const identity = document.createElement("div");
  identity.className = "ss-brand";
  const mark = document.createElement("img");
  const logoUrl = (globalThis.chrome || globalThis.browser)?.runtime?.getURL?.("icon/spacecast-prism.png");
  if (logoUrl) mark.src = logoUrl;
  else mark.hidden = true;
  mark.alt = "";
  mark.width = 24;
  mark.height = 24;
  mark.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.textContent = "SpaceCast";
  identity.append(mark, name);
  const badge = document.createElement("span");
  badge.className = "ss-state-badge";
  badge.textContent = "CONNECTING";
  header.append(identity, badge);

  const audio = document.createElement("audio");
  audio.id = SPACECAST_AUDIO_ID;
  audio.preload = "none";
  audio.hidden = true;
  const player = new SpacePlayerControls(audio);

  const row = document.createElement("div");
  row.className = "ss-recorder-actions";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Recording controls");
  const rec = recBadge();
  rec.button.disabled = true;

  const pause = transportButton("Pause recording");
  pause.appendChild(transportIcon(PAUSE_ICON));
  const eject = transportButton("Save this part and keep recording");
  eject.appendChild(transportIcon(EJECT_ICON));
  const stop = transportButton("Stop and save");
  stop.appendChild(transportIcon(STOP_ICON));
  const film = transportButton("Record video of this Space");
  film.appendChild(transportIcon(VIDEO_ICON));
  const filmLabel = document.createElement("span");
  filmLabel.textContent = "Video";
  film.appendChild(filmLabel);
  film.classList.add("ss-video");
  film.style.display = ScreenRecorder.supported ? "inline-flex" : "none";

  // Keep both codec choices visible; disable unsupported encoders.
  const codecs = document.createElement("div");
  codecs.className = "ss-codecs";
  codecs.setAttribute("role", "group");
  codecs.setAttribute("aria-label", "Video codec");
  const codecSegment = (label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    return button;
  };

  const avcSegment = codecSegment("H.264");
  const hevcSegment = codecSegment("HEVC");
  codecs.append(avcSegment, hevcSegment);

  const status = document.createElement("span");
  status.className = "ss-recording-status";
  status.setAttribute("role", "status");
  status.textContent = "Connecting to the Space…";
  const age = document.createElement("span");
  age.className = "ss-age";
  const copy = pillButton("Copy stream link");
  copy.classList.add("ss-copy");
  copy.title = "Copy the audio playlist link";
  copy.style.display = "none";
  row.append(rec.button, pause, eject, stop, film, codecs);

  const equalizer = new Equalizer();
  const visualizer = new AudioVisualizer(audio, equalizer);
  const spectrum = document.createElement("div");
  spectrum.className = "ss-spectrum";
  const spectrumHeader = document.createElement("div");
  spectrumHeader.className = "ss-section-label";
  const spectrumLabel = document.createElement("span");
  spectrumLabel.textContent = "AUDIO SPECTRUM";
  const sourceLabel = document.createElement("span");
  sourceLabel.textContent = "LIVE SIGNAL";
  spectrumHeader.append(spectrumLabel, sourceLabel);
  spectrum.append(spectrumHeader, visualizer.element);

  const recording = document.createElement("section");
  recording.className = "ss-recording";
  const recordingHeader = document.createElement("div");
  recordingHeader.className = "ss-section-label";
  const recordingTitle = document.createElement("span");
  recordingTitle.textContent = "CAPTURE";
  const recordingFormat = document.createElement("span");
  recordingFormat.textContent = "OPUS AUDIO";
  recordingHeader.append(recordingTitle, recordingFormat);
  recording.append(recordingHeader, row, status);

  const footer = document.createElement("div");
  footer.className = "ss-footer";
  const cacheStatus = document.createElement("div");
  cacheStatus.id = "spacecast-cache-status";
  cacheStatus.className = "ss-cache-status";
  cacheStatus.textContent = "Preparing live cache…";
  const footerActions = document.createElement("div");
  footerActions.className = "ss-footer-actions";
  footerActions.append(age, copy);
  footer.append(cacheStatus, footerActions);
  const retry = pillButton("Retry opening Space");
  retry.classList.add("ss-retry");
  retry.hidden = true;
  retry.style.display = "none";
  const content = document.createElement("div");
  content.className = "ss-window-content";
  content.append(audio, spectrum, player.element, equalizer.element, recording, footer, retry);
  panel.append(header, content);
  installStyles();

  // The context can only be started from a gesture, and taking the audio
  // over before then would mute it, so keep trying on the way in.
  const wakeVisualizer = () => visualizer.attach();
  panel.addEventListener("click", wakeVisualizer, true);
  audio.addEventListener("playing", wakeVisualizer);
  audio.addEventListener("volumechange", wakeVisualizer);

  // Capture the integrated Space sheet, or the player on a full Space page.
  let videoCaptureTarget = null;
  let captureMove = null;
  let captureMoveError = "";
  let playbackWasRunning = false;
  audio.addEventListener("playing", () => { playbackWasRunning = true; });
  audio.addEventListener("pause", () => { if (audio.isConnected) playbackWasRunning = false; });
  const video = new ScreenRecorder({
    targetOf: () => (videoCaptureTarget = panel.closest(".ss-sheet") || panel),
    audioTrackOf: () => visualizer.captureAudio(),
    nameOf: (extension) => buildFileName(space, extension, new Date(), 0),
    onchange: () => {
      if (video.state === "starting") captureMoveError = "";
      if (video.state == "idle") activeRecorders.delete(video);
      else activeRecorders.add(video);
      tick();
      render();
      refreshCaptureTarget();
    },
  });

  let recorder = null;
  let preroll = null;
  let ticker = null;
  let clock = null;
  let playlistUrl = null;
  let copiedUntil = 0;
  let disposed = false;
  let playbackError = "";
  let shellCleanup = () => {};
  let shellRefresh = () => {};
  let closeWhenIdle = null;
  let closeRequested = false;
  audio.addEventListener("play", () => {
    if (closeRequested) { audio.muted = true; audio.pause(); }
  });

  // Reuse the current capture stream and MediaRecorder if its presentation
  // moves to a new native sheet. Merely browsing never stops a recording.
  function refreshCaptureTarget() {
    const target = panel.closest(".ss-sheet") || panel;
    const track = video.stream?.getVideoTracks?.()[0];
    if (disposed || captureMove || !track || video.state !== "recording" || target === (video.restrictedTarget || videoCaptureTarget)) return;
    // Keep the current element restriction until its replacement succeeds.
    // If reframing fails, save the video without exposing the background page.
    const previous = video.isolated;
    const previousIsolation = target.style.isolation;
    captureMove = (async () => {
      if (video.framing.startsWith("element") && track.restrictTo && typeof RestrictionTarget !== "undefined") {
        target.style.isolation = "isolate";
        await track.restrictTo(await RestrictionTarget.fromElement(target));
        if (previous) previous.element.style.isolation = previous.previous;
        video.isolated = { element: target, previous: previousIsolation };
      } else if (video.framing.startsWith("region") && track.cropTo && typeof CropTarget !== "undefined") {
        await track.cropTo(await CropTarget.fromElement(target));
      } else {
        throw new Error("The browser cannot move the Space capture region");
      }
      videoCaptureTarget = target;
      video.restrictedTarget = target;
    })().catch(() => {
      target.style.isolation = previousIsolation;
      captureMoveError = "Video framing unavailable; video capture stopped. Audio continues.";
      video.stop();
    }).finally(() => {
      captureMove = null;
      if (!disposed) { render(); refreshCaptureTarget(); }
    });
  }

  // One timer, running while either recorder is going.
  const tick = () => {
    const busy = (recorder != null && recorder.state == "recording") || video.state == "recording";
    if (!disposed && busy && ticker == null) ticker = setInterval(render, 500);
    if (!busy && ticker != null) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  const detail = () => {
    if (recorder == null) return "";
    const size = formatSize(recorder.bytes);
    const clock = formatDuration(recorder.seconds);
    if (recorder.endList && recorder.totalSeconds > 0) {
      const percent = Math.min(100, (recorder.capturedSeconds / recorder.totalSeconds) * 100);
      return clock + " of " + formatDuration(recorder.totalSeconds) + " · " + percent.toFixed(0) + "% · " + size;
    }
    // Once Eject has been used the size is of the part in hand, so say which.
    const part = recorder.part > 1 ? " · pt" + recorder.part : "";
    return clock + " · " + size + part;
  };

  const idleStatus = () => {
    if (playlistUrl == null) return "connecting…";
    if (preroll == null || preroll.live === false) return "replay · ready";
    if (preroll.live == null) return "buffering…";
    // What matters to the listener is how far back of where they are now
    // the recording will begin, not the raw size of the buffer.
    const behind = Math.round(Math.min(preroll.seconds, preroll.retain) - preroll.lag);
    return "ready · " + Math.max(0, behind) + "s head start";
  };

  // Video runs alongside audio, so its progress is appended to whatever
  // the audio recorder is already saying rather than replacing it.
  const setStatus = (text) => {
    let line = playbackError || text;
    if (video.state == "recording") {
      // The framing is named out loud: it is the difference between a video
      // of the Space and a video of the whole tab.
      line += " · vid " + video.framing + " " + video.size + " " + video.codec +
        " " + formatDuration(video.seconds) + " " + formatSize(video.bytes);
    } else if (video.state == "starting") {
      line += " · starting video…";
    } else if (video.state == "saving") {
      line += " · saving video…";
    } else if (video.message != "" && video.message != "video saved") {
      line += " · " + video.message;
    }
    if (captureMoveError) line += " · " + captureMoveError;
    if (status.textContent !== line) status.textContent = line;
    status.title = recorder?.state === "done" ? recorder.fileName : line;
    panel.dataset.error = playbackError ? "true" : "false";
  };

  const render = () => {
    const state = recorder == null ? "idle" : recorder.state;
    if (closeWhenIdle && video.state === "recording") video.stop();
    if (closeWhenIdle && !["recording", "encoding", "saving"].includes(state) && video.state === "idle") {
      const close = closeWhenIdle;
      closeWhenIdle = null;
      queueMicrotask(close);
    }
    const filming = video.state != "idle";
    panel.dataset.recording = state;
    film.dataset.active = String(filming);
    filmLabel.textContent = video.state === "recording" ? "Stop video" : "Video";
    film.setAttribute("aria-label", video.state === "recording" ? "Stop video recording" : "Record video of this Space");
    player.setState(space);
    const spaceState = space.state === "Ended" ? "REPLAY" : (space.state === "Scheduled" || space.state === "NotStarted") ? "UPCOMING" : playlistUrl ? "LIVE" : "CONNECTING";
    badge.textContent = playbackError ? "CONNECTION ISSUE" : spaceState;
    badge.dataset.state = playbackError ? "error" : spaceState.toLowerCase();
    sourceLabel.textContent = space.state === "Ended" ? "REPLAY SIGNAL" : "LIVE SIGNAL";
    film.disabled = !!closeWhenIdle || video.state == "saving" || video.state == "starting";
    film.title = video.state == "recording" ? "Stop the video" : "Record video of this Space";

    // The picker is shown whenever video can be recorded at all. Where HEVC
    // is not on offer its half is greyed and says so, rather than the whole
    // control disappearing and leaving nothing to explain itself.
    codecs.style.display = ScreenRecorder.supported ? "inline-flex" : "none";
    film.style.display = ScreenRecorder.supported ? "inline-flex" : "none";
    for (const [segment, active] of [[avcSegment, !video.preferHevc], [hevcSegment, video.preferHevc]]) {
      const offered = segment != hevcSegment || video.hevcSupported;
      segment.disabled = filming || !offered;
      segment.setAttribute("aria-pressed", String(active && offered));
    }
    avcSegment.title = "Record video as H.264. Widest compatibility.";
    hevcSegment.title = video.hevcSupported
      ? "Record video as HEVC, encoded on the GPU. Smaller files."
      : "This browser reports no HEVC encoder, so HEVC cannot be recorded here.";
    const described = describeSpace(space, Date.now());
    age.textContent = described;
    age.style.display = described == "" ? "none" : "inline";
    const recording = state == "recording";
    const busy = state == "encoding" || state == "saving";

    copy.style.display = playlistUrl == null ? "none" : "inline-flex";
    copy.textContent = Date.now() < copiedUntil ? "Link copied" : "Copy stream link";

    // Armed, the badge starts a recording. Once one is running it is no
    // longer a control at all, only the light, and stopping is the square.
    const armed = playlistUrl != null && !recording && !busy && !closeWhenIdle;
    rec.button.disabled = !armed;
    rec.button.style.cursor = armed ? "pointer" : "default";
    rec.button.setAttribute("aria-label", recording ? "Recording" : "Start recording");

    // Pulsing while audio is going in; steady and dimmed while held.
    const live = recording && !recorder.paused && !recorder.stopRequested;
    rec.label.textContent = recording ? (recorder.paused ? "Recording paused" : "Recording") : busy ? "Saving audio…" : "Record audio";
    rec.dot.className = "ss-record-dot" + (live ? " " + BLINK_CLASS : "");
    rec.dot.style.opacity = recording && recorder.paused ? "0.4" : "1";

    // A replay downloads in one go, so there is nothing to pause or split.
    const transport = recording && !recorder.endList;
    pause.style.display = transport ? "inline-flex" : "none";
    eject.style.display = transport ? "inline-flex" : "none";
    stop.style.display = recording ? "inline-flex" : "none";

    if (recording) {
      const settling = recorder.stopRequested || recorder.ejecting;
      pause.disabled = settling;
      stop.disabled = recorder.stopRequested;
      eject.disabled = settling || recorder.ejectRequested || recorder.bytes == 0;

      pause.replaceChildren(transportIcon(recorder.paused ? PLAY_ICON : PAUSE_ICON));
      pause.setAttribute("aria-label", recorder.paused ? "Resume recording" : "Pause recording");
      pause.title = recorder.paused ? "Resume recording" : "Pause recording";
      pause.setAttribute("aria-pressed", String(recorder.paused));

      if (recorder.stopRequested) setStatus("stopping…");
      else if (recorder.ejecting) setStatus("saving part " + (recorder.part - 1) + "…");
      else if (recorder.ejectRequested) setStatus("part " + recorder.part + " queued · " + detail());
      else setStatus((recorder.paused ? "paused · " : "") + detail());
      return;
    }

    if (state == "encoding") {
      setStatus("converting to Opus…");
    } else if (state == "saving") {
      setStatus("saving…");
    } else if (state == "done") {
      setStatus(
        recorder.parts.length > 1
          ? "saved " + recorder.parts.length + " parts · " + formatSize(recorder.totalBytes) + " captured"
          : "Saved " + formatSize(recorder.bytes) + " · " + formatDuration(recorder.seconds)
      );
    } else if (state == "error") {
      setStatus("failed: " + recorder.message);
    } else {
      setStatus(idleStatus());
    }
  };

  rec.button.addEventListener("click", () => {
    if (playlistUrl == null) return;
    if (recorder != null && (recorder.state == "recording" || recorder.state == "encoding")) return;

    const buffered = preroll != null && preroll.live === true ? preroll.take() : null;
    if (preroll != null) preroll.stop();

    recorder = new SpaceRecorder(playlistUrl, space);
    recorder.onchange = render;
    tick();
    recorder.start(buffered).finally(() => {
      tick();
      // Start filling the buffer again, ready for another recording.
      if (!disposed && preroll != null && preroll.live !== false) {
        preroll = new PreRoll(playlistUrl, () => !disposed, () => playbackLag(audio));
        preroll.onchange = render;
        preroll.start();
      }
      render();
    });
    render();
  });

  pause.addEventListener("click", () => {
    if (recorder == null || recorder.state != "recording") return;
    recorder.setPaused(!recorder.paused);
    render();
  });

  film.addEventListener("click", () => {
    if (video.state == "recording") video.stop();
    else if (video.state == "idle") video.start();
  });

  avcSegment.addEventListener("click", () => {
    if (video.state == "idle") video.setPreferHevc(false);
  });
  hevcSegment.addEventListener("click", () => {
    if (video.state == "idle") video.setPreferHevc(true);
  });

  eject.addEventListener("click", () => {
    if (recorder == null || recorder.state != "recording") return;
    recorder.requestEject();
    render();
  });

  stop.addEventListener("click", () => {
    if (recorder == null || recorder.state != "recording") return;
    recorder.requestStop();
    render();
  });

  copy.addEventListener("click", async () => {
    if (playlistUrl == null) return;
    try {
      await navigator.clipboard.writeText(playlistUrl);
      copiedUntil = Date.now() + 1500;
    } catch (error) {
      console.warn("[spacecast] clipboard refused", error);
    }
    render();
    setTimeout(render, 1600);
  });

  return {
    space: space,
    element: panel,
    audio: audio,
    row: row,
    visualizer: visualizer,
    video: video,
    equalizer: equalizer,
    setPlaylistUrl(url) {
      preroll?.stop();
      playlistUrl = url;
      // Minute-granularity, so a slow tick is plenty to keep it honest.
      clearInterval(clock);
      clock = setInterval(() => {
        if (disposed) return clearInterval(clock);
        if (recorder == null || recorder.state != "recording") render();
      }, 15000);
      preroll = new PreRoll(url, () => !disposed, () => playbackLag(audio));
      preroll.onchange = render;
      preroll.start();
      render();
    },
    setCacheStatus(message) { if (cacheStatus.textContent !== message) cacheStatus.textContent = message; cacheStatus.title = message; },
    setShellCleanup(callback) { shellCleanup = callback; },
    setShellRefresh(callback) { shellRefresh = callback; },
    refreshShell() {
      shellRefresh();
      if (this.nativeSheet?.isConnected) this.spaceSnapshot = SpaceDock.snapshot(this.nativeSheet, space, this.spaceSnapshot);
    },
    releaseShell() {
      shellCleanup();
      shellCleanup = () => {};
      shellRefresh = () => {};
      this.nativeSheet = null;
      this.dock = null;
    },
    wantsPlayback() { return !closeRequested && (!audio.paused || (!panel.isConnected && playbackWasRunning)); },
    resumeAfterMove(playing) {
      if (!closeRequested && playing && audio.paused) audio.play().catch(() => {});
      refreshCaptureTarget();
    },
    requestClose(callback) {
      if (closeRequested) return;
      closeRequested = true;
      playbackWasRunning = false;
      audio.muted = true;
      audio.pause();
      closeWhenIdle = callback;
      if (recorder?.state === "recording") recorder.requestStop();
      if (video.state === "recording") video.stop();
      render();
    },
    setRetry(callback) {
      retry.onclick = callback || null;
      retry.hidden = !callback;
      retry.style.display = callback ? "inline-flex" : "none";
    },
    setError(message) {
      playbackError = message;
      render();
    },
    dispose() {
      disposed = true;
      clearInterval(clock);
      clearInterval(ticker);
      if (preroll) preroll.stop();
      if (video.state === "recording") video.stop();
      player.dispose();
      visualizer.dispose();
      shellCleanup();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      panel.remove();
    },
  };
}

// Theme only the active Space sheet. Native X actions and audience controls
// retain their handlers; the player gets its own full-width row.
function applySpaceAppearance(element, panel) {
  const update = event => panel.visualizer.setDisplayOptions(event.detail);
  element.addEventListener("spacecast:appearancechange", update);
  const appearance = new SpaceGlassAppearance(element);
  return () => {
    element.removeEventListener("spacecast:appearancechange", update);
    appearance.dispose();
  };
}

function nativeSpaceSheet() {
  // Other X dialogs use sheetDialog too; only adopt a Space preview.
  return [...document.querySelectorAll('div[data-testid="sheetDialog"]:not([data-ss-persistent])')].find(sheet =>
    sheet.classList.contains("ss-sheet") || (sheet.querySelector('[data-testid="tweetText"]') &&
      sheet.querySelector('[data-testid^="UserAvatar-Container-"], button[aria-label="Start listening"]'))
  ) || null;
}

function nativeListeningActive() {
  return !!document.querySelector('[aria-label="Manage Space"]');
}

function mountPanel(panel, isPeek) {
  if (isPeek) {
    const sheet = nativeSpaceSheet();
    if (!sheet) return false;
    panel.nativeSheet = sheet;
    const tagged = [];
    const tag = (element, name) => { if (element && !element.classList.contains(name)) { element.classList.add(name); tagged.push([element, name]); } };
    const attributes = [];
    const automaticDirection = element => {
      if (!element || element.getAttribute("dir") === "auto") return;
      attributes.push([element, "dir", element.getAttribute("dir")]);
      element.setAttribute("dir", "auto");
    };
    tag(sheet, "ss-sheet");
    const body = sheet.firstElementChild;
    tag(body, "ss-sheet-body");
    const anchor = sheet.querySelector(':scope > div > div > div > button');
    let heading;
    let details;
    if (anchor) {
      const toolbar = anchor.parentElement.parentElement;
      tag(toolbar, "ss-native-toolbar");
      heading = toolbar.nextElementSibling;
      const nestedTitle = heading?.querySelector('h1, h2, [role="heading"]');
      if (nestedTitle) {
        tag(nestedTitle, "ss-native-heading");
        tag(nestedTitle.nextElementSibling, "ss-people");
        if (heading.lastElementChild?.tagName === "BUTTON") tag(heading.lastElementChild, "ss-native-listen");
        nestedTitle.after(panel.element);
      } else if (heading && !heading.contains(panel.element)) {
        tag(heading, "ss-native-heading");
        if (heading.children.length > 1) {
          tag(heading.firstElementChild, "ss-sheet-rec");
          tag(body, "ss-has-rec");
        }
        tag(heading.lastElementChild, "ss-sheet-title");
        automaticDirection(heading.lastElementChild);
        details = heading.nextElementSibling === panel.element ? panel.element.nextElementSibling : heading.nextElementSibling;
        tag(details, "ss-native-details");
        heading.after(panel.element);
      } else toolbar.after(panel.element);
    } else sheet.firstElementChild ? sheet.firstElementChild.prepend(panel.element) : sheet.prepend(panel.element);

    const refresh = () => {
      if (!details?.isConnected) return;
      for (const child of details.children) {
        if (child.querySelector('a[href^="/"]')) {
          tag(child, "ss-people-wrap");
          let grid = child;
          while (grid.children.length === 1 && grid.firstElementChild.querySelector('a[href^="/"]')) grid = grid.firstElementChild;
          tag(grid, "ss-people");
          for (const card of grid.children) {
            if (!card.querySelector('a[href^="/"]')) continue;
            tag(card, "ss-person");
            tag(card.children[0], "ss-person-avatar");
            tag(card.children[1], "ss-person-name");
            tag(card.children[2], "ss-person-role");
          }
        } else if (child.querySelector('[role="switch"]')) {
          tag(child, "ss-anonymous");
        } else if (child.querySelector('button')) {
          tag(child, "ss-native-footer");
          tag(child.firstElementChild, "ss-notice");
          tag(child.querySelector('button'), "ss-native-listen");
        } else {
          tag(child, "ss-listeners");
          tag(child.firstElementChild, "ss-listeners-inner");
        }
      }
    };
    refresh();
    panel.setShellRefresh(refresh);
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "ss-sheet-grip";
    grip.title = "Drag the whole Space to move it";
    grip.append(transportIcon([{ tag: "path", d: "M8 3h2v3H8zm6 0h2v3h-2zM8 10h2v3H8zm6 0h2v3h-2zM8 17h2v3H8zm6 0h2v3h-2z" }]));
    body.append(grip);
    const shell = new SpaceSheet(sheet);
    const glass = new SpaceGlassWindow(sheet, { header: heading || body, titleElement: grip, controls: ["minimize"], controlsContainer: body });
    const disposeAppearance = applySpaceAppearance(sheet, panel);
    let closing = false;
    let escapeTurn = null;
    const rememberEscape = event => {
      if (event.key !== "Escape" || shell.hasOtherModal()) return;
      panel.nativeDismissal = true;
      clearTimeout(escapeTurn);
      // Observe intent only for this native event turn. Escape can dismiss a
      // menu without closing the Space; in that case nothing is stopped.
      escapeTurn = setTimeout(() => { panel.nativeDismissal = false; }, 0);
    };
    document.addEventListener("keydown", rememberEscape, true);
    const close = event => {
      if (closing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestSpaceClose(spaceSession, { onClosed: () => {
        closing = true;
        anchor.click();
      } });
    };
    // Stop our player before X starts native audio, regardless of its next URL.
    const join = event => {
      const target = event.target?.closest?.(".ss-native-listen");
      if (target && sheet.contains(target) && !panel.element.contains(target)) {
        requestSpaceClose(spaceSession, { native: true, hide: true });
      }
    };
    anchor?.addEventListener("click", close, true);
    sheet.addEventListener("click", join, true);
    panel.setShellCleanup(() => {
      clearTimeout(escapeTurn);
      panel.nativeDismissal = false;
      document.removeEventListener("keydown", rememberEscape, true);
      anchor?.removeEventListener("click", close, true);
      sheet.removeEventListener("click", join, true);
      disposeAppearance();
      glass.dispose();
      shell.dispose();
      grip.remove();
      for (const [element, name] of tagged) element.classList.remove(name);
      for (const [element, name, previous] of attributes) {
        if (element.getAttribute(name) !== "auto") continue;
        if (previous === null) element.removeAttribute(name);
        else element.setAttribute(name, previous);
      }
    });
    panel.spaceSnapshot = SpaceDock.snapshot(sheet, panel.space, panel.spaceSnapshot);
    return true;
  }
  mountSpaceDock(panel);
  return true;
}

function mountSpaceDock(panel, options = {}) {
  const dock = new SpaceDock(panel, panel.spaceSnapshot || SpaceDock.snapshot(null, panel.space), {
    ...options,
    appearance: applySpaceAppearance,
    onClose: () => { if (spaceSession?.panel === panel) requestSpaceClose(spaceSession); },
    onOpenControls: url => {
      if (spaceSession?.panel === panel) requestSpaceClose(spaceSession, {
        native: true, onClosed: () => location.assign(url),
      });
    },
  });
  panel.dock = dock;
  panel.setShellRefresh(() => dock.refresh());
  panel.setShellCleanup(() => dock.dispose());
}

// One owner per route. Old requests cannot attach audio to a new Space.
// The owner outlives ordinary X routes. Close, native listening, or another
// Space ends it. React owns the native popup, never the cache or recording session.
let spaceSession = null;
let reconcileQueued = false;
let dismissedSpacePath = "";
let nativeOwnedSpaceId = "";
let nativeOwnedSpacePath = "";
let nativeOwnedWasActive = false;
let nativeLeavePending = false;

// Cache startup can wait on IndexedDB, which does not accept an AbortSignal.
// Race every startup stage against cancellation so a hung store cannot strand UI.
function waitForSpaceStartup(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Opening this Space was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function closeSpaceSession() {
  const session = spaceSession;
  spaceSession = null;
  if (!session) return;
  session.controller.abort();
  clearTimeout(session.recoveryTimer);
  session.hls?.destroy();
  session.cache?.destroy();
  session.panel.dispose();
}

async function openSpaceSession(session) {
  const { space, panel, controller } = session;
  const current = () => spaceSession === session && !session.closing && !controller.signal.aborted;
  let stage = "Space details";
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  try {
    const api = new SpaceCastApi(controller.signal);
    const response = await waitForSpaceStartup(api.AudioSpaceById(space.id), controller.signal);
    if (!current()) return;
    Object.assign(space, readSpace(response, space.id));
    const metadata = response?.data?.audioSpace?.metadata;
    if (!metadata) throw new Error("This Space is unavailable or requires access through X");
    if (!metadata.media_key) throw new Error(space.state === "NotStarted" || space.state === "Scheduled"
      ? "This Space has not started yet" : "X returned no audio for this Space");
    stage = "Audio URL";
    const stream = await waitForSpaceStartup(api.live_video_stream(metadata.media_key), controller.signal);
    if (!current()) return;
    const url = stream?.source?.location;
    if (!url) throw new Error("No playable audio is available for this Space");
    if (new URL(url).protocol !== "https:") throw new Error("X returned an invalid audio URL");
    stage = "Playback setup";
    if (typeof Hls === "undefined" || !Hls.isSupported()) {
      throw new Error("This browser does not support the audio cache player");
    }
    stage = "Audio cache";
    const cache = session.cache = new SpaceLiveCache(url, {
      onchange: () => { if (current()) panel.setCacheStatus(cache.status()); },
    });
    await waitForSpaceStartup(cache.start(), controller.signal);
    if (!current()) { cache.destroy(); return; }
    stage = "Playback setup";
    panel.setPlaylistUrl(url);
    const hls = session.hls = new Hls({
      loader: cache.loaderClass(Hls.DefaultConfig.loader),
      // MSE stays small; the session cache retains older audio on disk.
      backBufferLength: 90,
      maxBufferLength: 30,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: Infinity,
    });
    let failures = 0;
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!current() || !data.fatal) return;
      panel.setError("Playback interrupted: " + data.details + ". Live capture continues.");
      if (++failures > 3) {
        clearTimeout(session.recoveryTimer);
        panel.setRetry(() => {
          if (!current()) return;
          failures = 0;
          panel.setRetry(null);
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          hls.startLoad(panel.audio.currentTime);
        });
        return;
      }
      clearTimeout(session.recoveryTimer);
      session.recoveryTimer = setTimeout(() => {
        if (!current()) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        hls.startLoad(panel.audio.currentTime);
      }, 1000 * failures);
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (!current()) return;
      failures = 0;
      clearTimeout(session.recoveryTimer);
      panel.setError("");
      panel.setRetry(null);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (current()) panel.audio.play().catch(() => {});
    });
    hls.attachMedia(panel.audio);
    hls.loadSource(url);
  } catch (error) {
    if (spaceSession !== session || session.closing) return;
    controller.abort();
    clearTimeout(session.recoveryTimer);
    session.cache?.destroy();
    session.hls?.destroy();
    const detail = error.message || String(error);
    const message = timedOut ? stage + " timed out. Retry opening this Space." : (detail.startsWith(stage + ":") ? detail : stage + ": " + detail);
    console.warn("[SpaceCast] Could not open Space " + space.id + ": " + message);
    panel.setError(message);
    panel.setRetry(() => {
      if (spaceSession !== session || session.closing) return;
      session.controller = new AbortController();
      session.cache = null;
      session.hls = null;
      panel.setError("");
      panel.setRetry(null);
      void openSpaceSession(session);
    });
  } finally {
    clearTimeout(timeout);
  }
}

function requestSpaceClose(session, { native = false, hide = false, suppress = true, onClosed } = {}) {
  if (!session || spaceSession !== session || session.closing) return;
  session.closing = true;
  if (suppress) dismissedSpacePath = location.pathname;
  if (native) {
    nativeOwnedSpaceId = session.space.id;
    nativeOwnedSpacePath = location.pathname;
    nativeOwnedWasActive = nativeListeningActive();
    nativeLeavePending = false;
  }
  session.controller.abort();
  clearTimeout(session.recoveryTimer);
  session.panel.audio.muted = true;
  session.panel.audio.pause();
  if (hide) {
    session.panel.element.style.display = "none";
    if (session.panel.dock) session.panel.dock.root.style.display = "none";
  }
  // Audio/video recording owns its own input. Let final encoding and saving
  // finish, but never keep audible playback or recreate a closing window.
  session.panel.requestClose(() => {
    if (spaceSession !== session) return;
    closeSpaceSession();
    onClosed?.();
  });
}

function preserveSpacePresentation(session, force = false) {
  const panel = session.panel;
  const playing = panel.wantsPlayback();
  if (panel.dock) {
    panel.dock.refresh();
    panel.resumeAfterMove(playing);
    return;
  }
  if (panel.element.isConnected && !force) return;
  const sheet = panel.nativeSheet;
  // Read the detached tree while it is still available. When X has reused a
  // connected sheet for a different Space, retain the last known old snapshot.
  if (sheet && !sheet.isConnected) panel.spaceSnapshot = SpaceDock.snapshot(sheet, panel.space, panel.spaceSnapshot);
  const position = sheet ? { x: parseFloat(sheet.style.left), y: parseFloat(sheet.style.top) } : null;
  const minimized = sheet?.dataset.minimized === "true";
  const reusableRoot = sheet && !sheet.isConnected ? sheet : null;
  panel.releaseShell();
  mountSpaceDock(panel, { root: reusableRoot, position, minimized });
  panel.resumeAfterMove(playing);
}

function restoreNativePresentation(session) {
  const panel = session.panel;
  const sheet = nativeSpaceSheet();
  if (!sheet || (panel.nativeSheet === sheet && panel.element.isConnected)) return false;
  const playing = panel.wantsPlayback();
  panel.releaseShell();
  if (!mountPanel(panel, true)) mountSpaceDock(panel);
  panel.resumeAfterMove(playing);
  return true;
}

function reconcileSpace() {
  const match = /^\/i\/spaces\/([A-Za-z0-9_-]+)(\/peek)?(?:\/|$)/.exec(location.pathname);
  if (spaceSession?.closing) return;
  const nativeActive = nativeListeningActive();
  if (nativeOwnedSpaceId) {
    if (nativeActive) nativeOwnedWasActive = true;
    else if (nativeLeavePending || nativeOwnedWasActive || nativeOwnedSpacePath !== location.pathname) {
      // Ending/disconnecting native audio must not permanently blacklist a Space.
      // If it ends in an open preview, wait for an explicit reopen before autoplay.
      if (nativeLeavePending || nativeOwnedWasActive) dismissedSpacePath = location.pathname;
      nativeOwnedSpaceId = "";
      nativeOwnedSpacePath = "";
      nativeOwnedWasActive = false;
      nativeLeavePending = false;
    }
  }
  if (dismissedSpacePath && dismissedSpacePath !== location.pathname) dismissedSpacePath = "";
  // A join can return to the background article instead of a Space URL.
  // Native ownership therefore follows user intent and X's controls, not URL alone.
  const nativeMode = new URLSearchParams(location.search).get("spacecast") === "native";
  if (spaceSession && (nativeActive || nativeMode || (match && !match[2] && match[1] === spaceSession.space.id))) {
    requestSpaceClose(spaceSession, { native: true, hide: true });
    return;
  }
  if (spaceSession?.panel.nativeDismissal && !spaceSession.panel.nativeSheet?.isConnected) {
    requestSpaceClose(spaceSession, { hide: true });
    return;
  }
  if (spaceSession && match && spaceSession.space.id !== match[1]) {
    const previous = spaceSession;
    requestSpaceClose(previous, { suppress: false, hide: true, onClosed: reconcileSpace });
    return;
  }
  if (spaceSession) {
    if (match && match[1] === spaceSession.space.id && nativeSpaceSheet()) restoreNativePresentation(spaceSession);
    if (!spaceSession.panel.element.isConnected) preserveSpacePresentation(spaceSession);
    spaceSession.panel.refreshShell();
  }
  if (!match || spaceSession || !match[2]) return;
  if (nativeMode || nativeActive || nativeOwnedSpaceId === match[1]) return;
  if (dismissedSpacePath === location.pathname) return;
  // The preview often appears before its sheet. Full native Space routes never
  // start a second player, and unrelated dialogs are never adopted.
  if (!nativeSpaceSheet()) return;
  let panel;
  try {
    const space = { id: match[1], url: "https://x.com/i/spaces/" + match[1], title: "", host: "", state: "" };
    panel = createPanel(space);
    if (!mountPanel(panel, true)) { panel.dispose(); return; }
    const session = spaceSession = { space, panel, controller: new AbortController(), cache: null, hls: null };
    void openSpaceSession(session);
  } catch (error) {
    panel?.dispose();
    console.warn("[SpaceCast] Player setup failed: " + (error.message || error));
  }
}

// Leaving native listening explicitly permits a later preview to own playback.
// Suppress the current route until that preview is actually reopened.
document.addEventListener("click", event => {
  if (!nativeOwnedSpaceId) return;
  const target = event.target?.closest?.('button, [role="button"]');
  if (!target || !nativeListeningActive()) return;
  const label = (target.getAttribute("aria-label") || target.textContent || "").trim();
  if (label !== "Leave") return;
  nativeLeavePending = true;
  queueMicrotask(reconcileSpace);
}, true);

new MutationObserver(() => {
  if (reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(() => { reconcileQueued = false; reconcileSpace(); });
}).observe(document, { childList: true, subtree: true });
window.addEventListener("popstate", reconcileSpace);
window.addEventListener("pagehide", closeSpaceSession);
window.addEventListener("pageshow", reconcileSpace);
reconcileSpace();
