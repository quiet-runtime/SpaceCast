/* SpaceCast's custom transport. The media element remains the playback owner. */
class SpacePlayerControls {
  constructor(audio) {
    this.audio = audio;
    this.live = true;
    this.disposed = false;
    this.playPending = false;
    this.listeners = [];
    this.lastVolume = audio.volume > 0 ? audio.volume : 1;

    this.element = this.node("div", "ss-player-controls");
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "Space audio player");
    this.timeline = this.node("div", "ss-timeline");
    const timeRow = this.node("div", "ss-time-row");
    this.currentTime = this.node("span", "ss-current-time", "0:00");
    this.duration = this.node("span", "ss-duration", "Waiting for audio");
    timeRow.append(this.currentTime, this.duration);
    const seekTrack = this.node("div", "ss-seek-track");
    this.bufferedTrack = this.node("div", "ss-buffered");
    this.bufferedTrack.setAttribute("aria-hidden", "true");
    this.seek = this.node("input", "ss-seek");
    this.seek.type = "range";
    this.seek.min = "0";
    this.seek.max = "1";
    this.seek.step = "0.1";
    this.seek.value = "0";
    this.seek.setAttribute("aria-label", "Playback position");
    seekTrack.append(this.bufferedTrack, this.seek);
    this.timeline.append(timeRow, seekTrack);

    this.transport = this.node("div", "ss-transport");
    this.back = this.button("ss-skip ss-skip-back", "Rewind 10 seconds", "back");
    this.play = this.button("ss-play", "Play", "play");
    this.forward = this.button("ss-skip ss-skip-forward", "Forward 10 seconds", "forward");
    this.liveButton = this.button("ss-live", "Jump to live audio", "live");
    this.liveLabel = this.node("span", "ss-live-label", "LIVE");
    this.liveButton.appendChild(this.liveLabel);
    const volumeWrap = this.node("div", "ss-volume-wrap");
    this.mute = this.button("ss-mute", "Mute", "volume");
    this.volume = this.node("input", "ss-volume");
    this.volume.type = "range";
    this.volume.min = "0";
    this.volume.max = "1";
    this.volume.step = "0.01";
    this.volume.setAttribute("aria-label", "Volume");
    volumeWrap.append(this.mute, this.volume);
    this.transport.append(this.back, this.play, this.forward, this.liveButton, volumeWrap);
    this.status = this.node("span", "ss-player-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.element.append(this.timeline, this.transport, this.status);

    this.listen(this.play, "click", () => this.togglePlayback());
    this.listen(this.back, "click", () => this.seekTo(this.position() - 10));
    this.listen(this.forward, "click", () => this.seekTo(this.position() + 10));
    this.listen(this.liveButton, "click", () => {
      const bounds = this.bounds();
      if (!bounds) return;
      this.seekTo(Math.max(bounds.start, bounds.end - 3));
      if (audio.paused) this.togglePlayback();
    });
    this.listen(this.seek, "input", () => this.seekTo(Number(this.seek.value)));
    this.listen(this.volume, "input", () => {
      const volume = Number(this.volume.value);
      if (!Number.isFinite(volume)) return;
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.muted = false;
      this.renderVolume();
    });
    this.listen(this.mute, "click", () => {
      if (audio.muted || audio.volume === 0) {
        if (audio.volume === 0) audio.volume = this.lastVolume;
        audio.muted = false;
      } else audio.muted = true;
      this.renderVolume();
    });
    for (const event of ["loadedmetadata", "loadeddata", "durationchange", "timeupdate", "progress", "play", "pause", "ended", "seeking", "seeked", "emptied", "canplay", "playing", "waiting", "stalled", "error"]) {
      this.listen(audio, event, () => {
        if (["waiting", "stalled", "seeking"].includes(event)) this.element.dataset.buffering = "true";
        if (["playing", "canplay", "seeked", "pause", "ended", "emptied", "error"].includes(event)) this.element.dataset.buffering = "false";
        if (["play", "playing"].includes(event)) this.status.textContent = "";
        this.render();
      });
    }
    this.listen(audio, "volumechange", () => this.renderVolume());
    this.render();
  }

  node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "22", height: "22", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
    const paths = {
      play: [{ tag: "path", d: "M9 5.5 19 12 9 18.5Z", fill: "currentColor", stroke: "none" }],
      pause: [{ tag: "rect", x: "6.5", y: "5", width: "4", height: "14", rx: "1", fill: "currentColor", stroke: "none" }, { tag: "rect", x: "13.5", y: "5", width: "4", height: "14", rx: "1", fill: "currentColor", stroke: "none" }],
      back: [{ tag: "path", d: "M4 8a9 9 0 1 1-1 8M4 3v5h5" }],
      forward: [{ tag: "path", d: "M20 8a9 9 0 1 0 1 8M20 3v5h-5" }],
      live: [{ tag: "circle", cx: "12", cy: "12", r: "4", fill: "currentColor", stroke: "none" }],
      volume: [{ tag: "path", d: "M11 5 6 9H3v6h3l5 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" }],
      muted: [{ tag: "path", d: "M11 5 6 9H3v6h3l5 4ZM16 9l5 6M21 9l-5 6" }],
    };
    for (const { tag, ...attributes } of paths[name] || []) {
      const shape = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
      svg.appendChild(shape);
    }
    if (name === "back" || name === "forward") {
      const label = document.createElementNS(ns, "text");
      for (const [key, value] of Object.entries({ x: "12", y: "15.5", fill: "currentColor", stroke: "none", "font-size": "8", "font-weight": "700", "font-family": "system-ui,sans-serif", "text-anchor": "middle" })) label.setAttribute(key, value);
      label.textContent = "10";
      svg.appendChild(label);
    }
    return svg;
  }

  button(className, label, icon) {
    const button = this.node("button", className);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.appendChild(this.icon(icon));
    return button;
  }

  listen(target, event, handler) {
    target.addEventListener(event, handler);
    this.listeners.push(() => target.removeEventListener(event, handler));
  }

  ranges() {
    const ranges = [];
    const seekable = this.audio.seekable;
    if (seekable) {
      for (let index = 0; index < seekable.length; index++) {
        const start = seekable.start(index), end = seekable.end(index);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) ranges.push({ start, end });
      }
    }
    // A finite duration alone is not a valid live DVR window. MSE may report
    // duration before there is any seekable media, or after the window slides.
    if (!ranges.length && !this.live && this.audio.readyState >= 1 && Number.isFinite(this.audio.duration) && this.audio.duration > 0) ranges.push({ start: 0, end: this.audio.duration });
    return ranges;
  }

  bounds() {
    const ranges = this.ranges();
    return ranges.length ? { start: ranges[0].start, end: ranges[ranges.length - 1].end, ranges } : null;
  }

  position() {
    return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
  }

  seekTo(requested) {
    const bounds = this.bounds();
    if (!bounds || !Number.isFinite(requested) || this.disposed) return;
    let target = Math.max(bounds.start, Math.min(bounds.end - 0.05, requested));
    // Do not seek into discontinuity gaps, including a DVR window that moved
    // while the user was dragging. Use the closest still-available boundary.
    if (!bounds.ranges.some(range => target >= range.start && target < range.end)) {
      const edges = bounds.ranges.flatMap(range => [range.start, Math.max(range.start, range.end - 0.05)]);
      target = edges.reduce((nearest, edge) => Math.abs(edge - target) < Math.abs(nearest - target) ? edge : nearest, edges[0]);
    }
    try {
      this.audio.currentTime = target;
      this.status.textContent = "";
    } catch (_) {
      this.status.textContent = "That audio is not ready yet. Try again in a moment.";
    }
    this.render();
  }

  async togglePlayback() {
    if (this.disposed || this.playPending || this.play.disabled) return;
    if (!this.audio.paused && !this.audio.ended) {
      this.audio.pause();
      return;
    }
    this.playPending = true;
    this.play.disabled = true;
    try {
      await this.audio.play();
      if (!this.disposed) this.status.textContent = "";
    } catch (error) {
      if (!this.disposed && error?.name !== "AbortError") this.status.textContent = "Audio could not start. Press play to try again.";
    } finally {
      this.playPending = false;
      if (!this.disposed) this.render();
    }
  }

  setState(space) {
    const state = typeof space === "string" ? space : space?.state;
    this.live = !["ended", "recorded", "replay"].includes(String(state || "").toLowerCase());
    this.render();
  }

  formatTime(value) {
    const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
    return (hours ? hours + ":" + String(minutes).padStart(2, "0") : String(minutes)) + ":" + String(seconds).padStart(2, "0");
  }

  renderVolume() {
    if (this.disposed) return;
    const volume = Number.isFinite(this.audio.volume) ? this.audio.volume : 1;
    if (volume > 0) this.lastVolume = volume;
    const muted = this.audio.muted || volume === 0;
    const shown = muted ? 0 : volume;
    this.volume.value = String(shown);
    this.volume.setAttribute("aria-valuetext", Math.round(shown * 100) + " percent");
    this.volume.style.setProperty("--ss-volume", Math.round(shown * 100) + "%");
    const label = muted ? "Unmute" : "Mute";
    this.mute.setAttribute("aria-label", label);
    this.mute.setAttribute("aria-pressed", String(muted));
    this.mute.title = label;
    if (this.mute.dataset.icon !== (muted ? "muted" : "volume")) {
      this.mute.dataset.icon = muted ? "muted" : "volume";
      this.mute.replaceChildren(this.icon(this.mute.dataset.icon));
    }
  }

  render() {
    if (this.disposed) return;
    const bounds = this.bounds();
    const ready = this.audio.readyState >= 1 && !!bounds;
    const playing = !this.audio.paused && !this.audio.ended;
    const position = this.position();
    this.element.dataset.ready = String(ready);
    this.element.dataset.playing = String(playing);
    this.element.dataset.live = String(this.live);
    const atLive = this.live && !!bounds && bounds.end - position <= 5;
    this.element.dataset.atLive = String(atLive);
    this.play.disabled = !ready || this.playPending;
    this.seek.disabled = !ready;
    this.back.disabled = !ready || position <= bounds.start + 0.1;
    this.forward.disabled = !ready || position >= bounds.end - 0.1;
    this.liveButton.disabled = !ready;
    this.liveButton.hidden = !this.live;
    this.liveButton.setAttribute("aria-label", atLive ? "At live audio" : "Jump to live audio");
    this.liveButton.title = atLive ? "At the live edge" : "Jump to live audio";
    const playLabel = playing ? "Pause" : this.audio.ended ? "Replay" : "Play";
    this.play.setAttribute("aria-label", playLabel);
    this.play.title = playLabel;
    const playIcon = playing ? "pause" : "play";
    if (this.play.dataset.icon !== playIcon) {
      this.play.dataset.icon = playIcon;
      this.play.replaceChildren(this.icon(playIcon));
    }
    if (bounds) {
      const span = bounds.end - bounds.start;
      const shown = Math.max(bounds.start, Math.min(bounds.end, position));
      this.seek.min = String(bounds.start);
      this.seek.max = String(bounds.end);
      this.seek.value = String(shown);
      const elapsed = this.formatTime(shown - bounds.start);
      const duration = this.formatTime(span);
      this.currentTime.textContent = elapsed;
      this.duration.textContent = duration + (this.live ? " available" : "");
      this.seek.setAttribute("aria-valuetext", elapsed + " of " + duration + (this.live ? " available audio" : ""));
      this.timeline.style.setProperty("--ss-progress", ((shown - bounds.start) / span * 100).toFixed(2) + "%");
      let buffered = bounds.start;
      const ranges = this.audio.buffered;
      if (ranges) for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= shown + 0.2 && ranges.end(i) >= shown) buffered = Math.min(bounds.end, ranges.end(i));
      }
      this.timeline.style.setProperty("--ss-buffered", (Math.max(0, buffered - bounds.start) / span * 100).toFixed(2) + "%");
    } else {
      this.seek.min = "0";
      this.seek.max = "1";
      this.seek.value = "0";
      this.seek.setAttribute("aria-valuetext", "Waiting for audio");
      this.currentTime.textContent = "0:00";
      this.duration.textContent = "Waiting for audio";
      this.timeline.style.setProperty("--ss-progress", "0%");
      this.timeline.style.setProperty("--ss-buffered", "0%");
    }
    this.renderVolume();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.listeners.splice(0)) remove();
    this.element.remove();
  }
}
