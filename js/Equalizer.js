/* 16-band graphic equalizer using ISO two-thirds-octave centre frequencies.
 * It processes playback and the video-audio fallback. Direct audio recordings
 * are taken from network segments and do not use this processing chain. */

// ISO preferred centres, every other third-octave step.
const EQ_BANDS = [20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000, 8000, 12500, 16000];
const EQ_RANGE = 12; // dB either way
// Match bandwidth to the band spacing while limiting adjacent-band overlap.
const EQ_Q = 2.1;
const EQ_DETENT = 0.6; // dB within which a slider snaps back to flat
const EQ_STORAGE = "spacecast.eq";

function formatBand(hz) {
  if (hz >= 1000) return hz % 1000 == 0 ? hz / 1000 + "k" : (hz / 1000).toFixed(1) + "k";
  return String(hz);
}

class Equalizer {
  constructor() {
    this.gains = EQ_BANDS.map(() => 0);
    this.filters = [];
    this.bypassed = false;
    this.collapsed = true;
    this.restore();
    this.build();
  }

  /* ------------------------------ audio ----------------------------- */

  // Peaking filters provide each slider's stated gain at its centre frequency,
  // including the lowest and highest bands.
  createChain(context) {
    this.filters = EQ_BANDS.map((hz, index) => {
      const filter = context.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = hz;
      filter.Q.value = EQ_Q;
      filter.gain.value = this.bypassed ? 0 : this.gains[index];
      return filter;
    });

    for (let i = 0; i < this.filters.length - 1; i++) this.filters[i].connect(this.filters[i + 1]);
    return { head: this.filters[0], tail: this.filters[this.filters.length - 1] };
  }

  apply(index) {
    const filter = this.filters[index];
    if (filter == null) return;
    const value = this.bypassed ? 0 : this.gains[index];
    // Ramped rather than assigned, so dragging a slider does not click.
    if (filter.gain.setTargetAtTime != null && filter.context != null) {
      filter.gain.setTargetAtTime(value, filter.context.currentTime, 0.01);
    } else {
      filter.gain.value = value;
    }
  }

  setGain(index, db) {
    const clamped = Math.max(-EQ_RANGE, Math.min(EQ_RANGE, db));
    this.gains[index] = Math.abs(clamped) < EQ_DETENT ? 0 : Math.round(clamped * 10) / 10;
    this.apply(index);
    this.paintBand(index);
    this.save();
  }

  reset() {
    for (let index = 0; index < EQ_BANDS.length; index++) {
      this.gains[index] = 0;
      this.apply(index);
      this.paintBand(index);
    }
    this.save();
  }

  setBypassed(bypassed) {
    this.bypassed = bypassed;
    for (let index = 0; index < EQ_BANDS.length; index++) this.apply(index);
    this.paint();
    this.save();
  }

  /* ---------------------------- storage ----------------------------- */

  save() {
    try {
      localStorage.setItem(
        EQ_STORAGE,
        JSON.stringify({ gains: this.gains, bypassed: this.bypassed, collapsed: this.collapsed })
      );
    } catch (error) {
      /* private mode, or the page forbids it: settings just will not stick */
    }
  }

  restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(EQ_STORAGE) || "null");
      if (saved == null) return;
      if (Array.isArray(saved.gains) && saved.gains.length == EQ_BANDS.length) {
        this.gains = saved.gains.map((value) =>
          typeof value == "number" && isFinite(value) ? Math.max(-EQ_RANGE, Math.min(EQ_RANGE, value)) : 0
        );
      }
      this.bypassed = saved.bypassed === true;
      if (typeof saved.collapsed == "boolean") this.collapsed = saved.collapsed;
    } catch (error) {
      /* unreadable: start flat */
    }
  }

  /* ------------------------------ view ------------------------------ */

  build() {
    this.element = document.createElement("div");
    this.element.className = "ss-equalizer";
    Object.assign(this.element.style, {
      background: "rgba(19, 17, 27, 0.62)",
      border: "1px solid rgba(189, 147, 249, 0.12)",
      borderRadius: "14px",
      padding: "10px 12px",
      boxSizing: "border-box",
      font: "600 10px/1 " + UI_FONT,
      color: "#f8f8f2",
    });

    const header = document.createElement("div");
    header.className = "ss-eq-header";
    Object.assign(header.style, { display: "flex", alignItems: "center", gap: "8px" });

    this.title = document.createElement("button");
    this.title.className = "ss-eq-title";
    this.title.type = "button";
    Object.assign(this.title.style, {
      flex: "1 1 auto",
      textAlign: "left",
      background: "transparent",
      border: "0",
      padding: "5px 0",
      color: "#c7c3d8",
      font: "600 11px/1 " + UI_FONT,
      letterSpacing: "0.02em",
      cursor: "pointer",
    });
    this.title.addEventListener("click", () => this.setCollapsed(!this.collapsed));

    this.bypass = this.chip("On", () => this.setBypassed(!this.bypassed));
    this.bypass.classList.add("ss-eq-bypass");
    this.bypass.setAttribute("aria-label", "Enable equalizer");
    const flat = this.chip("Reset", () => this.reset());
    flat.classList.add("ss-eq-reset");
    flat.title = "Reset all 16 bands to 0 dB";
    flat.setAttribute("aria-label", "Reset all equalizer bands to zero");

    header.append(this.title, this.bypass, flat);

    this.bands = document.createElement("div");
    this.bands.className = "ss-eq-bands";
    Object.assign(this.bands.style, {
      display: "grid",
      gridTemplateColumns: "repeat(16, minmax(0, 1fr))",
      alignItems: "end",
      gap: "3px",
      marginTop: "16px",
      paddingBottom: "2px",
    });

    this.sliders = EQ_BANDS.map((hz, index) => this.buildBand(hz, index));
    for (const slider of this.sliders) this.bands.appendChild(slider.column);

    this.element.append(header, this.bands);
    this.paint();
  }

  chip(text, onClick) {
    const button = document.createElement("button");
    button.className = "ss-eq-chip";
    button.type = "button";
    button.textContent = text;
    Object.assign(button.style, {
      flex: "0 0 auto",
      padding: "5px 9px",
      border: "1px solid rgba(189, 147, 249, 0.15)",
      borderRadius: "9999px",
      background: "transparent",
      color: "#9895ad",
      font: "600 10px/1 " + UI_FONT,
      cursor: "pointer",
    });
    button.addEventListener("click", onClick);
    return button;
  }

  buildBand(hz, index) {
    const column = document.createElement("div");
    column.className = "ss-eq-band";
    Object.assign(column.style, {
      flex: "1 1 0",
      minWidth: "0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "8px",
      borderRadius: "5px",
      touchAction: "none",
      cursor: "ns-resize",
    });

    const readout = document.createElement("div");
    readout.className = "ss-eq-readout";
    Object.assign(readout.style, {
      color: "#c7c3d8",
      fontVariantNumeric: "tabular-nums",
      font: "500 8px/1 " + UI_FONT,
    });

    const track = document.createElement("div");
    track.className = "ss-eq-track";
    Object.assign(track.style, {
      position: "relative",
      width: "100%",
      height: "64px",
      display: "flex",
      justifyContent: "center",
    });

    const groove = document.createElement("div");
    Object.assign(groove.style, {
      position: "absolute",
      top: "0",
      bottom: "0",
      width: "3px",
      borderRadius: "2px",
      background: "rgba(189, 147, 249, 0.16)",
    });

    // The centre line, so flat is findable without reading the numbers.
    const centre = document.createElement("div");
    Object.assign(centre.style, {
      position: "absolute",
      left: "10%",
      right: "10%",
      top: "50%",
      height: "1px",
      background: "rgba(189, 147, 249, 0.18)",
    });

    const cap = document.createElement("div");
    cap.className = "ss-eq-cap";
    Object.assign(cap.style, {
      position: "absolute",
      left: "15%",
      right: "15%",
      height: "8px",
      marginTop: "-4px",
      borderRadius: "4px",
      background: "linear-gradient(180deg, #474054, #292331)",
      boxShadow: "0 2px 5px rgba(0,0,0,0.5)",
      pointerEvents: "none",
    });

    const lit = document.createElement("div");
    Object.assign(lit.style, {
      position: "absolute",
      left: "3px",
      right: "3px",
      top: "3px",
      height: "2px",
      borderRadius: "1px",
      background: "#bd93f9",
    });
    cap.appendChild(lit);

    track.append(groove, centre, cap);

    const label = document.createElement("div");
    label.className = "ss-eq-frequency";
    label.textContent = formatBand(hz);
    Object.assign(label.style, {
      color: "#9895ad",
      font: "500 8px/1 " + UI_FONT,
      whiteSpace: "nowrap",
    });

    column.append(readout, track, label);
    column.tabIndex = 0;
    column.setAttribute("role", "slider");
    column.setAttribute("aria-label", hz + " Hz equalizer gain");
    column.setAttribute("aria-orientation", "vertical");
    column.title = hz + " Hz · drag or use arrow keys · double-click to reset";
    column.setAttribute("aria-valuemin", String(-EQ_RANGE));
    column.setAttribute("aria-valuemax", String(EQ_RANGE));

    const fromEvent = (event) => {
      const rect = track.getBoundingClientRect();
      const position = (event.clientY - rect.top) / Math.max(1, rect.height);
      this.setGain(index, (0.5 - position) * 2 * EQ_RANGE);
    };

    column.addEventListener("pointerdown", (event) => {
      column.setPointerCapture(event.pointerId);
      fromEvent(event);
      event.preventDefault();
    });
    column.addEventListener("pointermove", (event) => {
      if (column.hasPointerCapture(event.pointerId)) fromEvent(event);
    });
    column.addEventListener("dblclick", () => this.setGain(index, 0));
    column.addEventListener(
      "wheel",
      (event) => {
        this.setGain(index, this.gains[index] - Math.sign(event.deltaY) * 0.5);
        event.preventDefault();
      },
      { passive: false }
    );
    column.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 0.1 : 1;
      if (event.key == "ArrowUp") this.setGain(index, this.gains[index] + step);
      else if (event.key == "ArrowDown") this.setGain(index, this.gains[index] - step);
      else if (event.key == "Home" || event.key == "0") this.setGain(index, 0);
      else return;
      event.preventDefault();
    });

    return { column, readout, cap, lit };
  }

  paintBand(index) {
    const slider = this.sliders[index];
    if (slider == null) return;
    const gain = this.gains[index];

    slider.readout.textContent = gain.toFixed(1);
    slider.cap.style.top = ((0.5 - gain / (2 * EQ_RANGE)) * 100).toFixed(2) + "%";
    slider.column.setAttribute("aria-valuenow", String(gain));
    slider.column.setAttribute("aria-valuetext", gain.toFixed(1) + " dB");

    const dim = this.bypassed;
    slider.lit.style.background = dim
      ? "#625d74"
      : gain == 0
        ? "#bd93f9"
        : gain > 0
          ? "#8be9fd"
          : "#ff79c6";
    slider.readout.style.color = dim ? "#625d74" : "#c7c3d8";
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.paint();
    this.save();
  }

  paint() {
    this.bands.style.display = this.collapsed ? "none" : "grid";
    this.title.textContent = (this.collapsed ? "▸" : "▾") + " Equalizer";
    this.title.setAttribute("aria-expanded", String(!this.collapsed));
    this.title.title = this.collapsed ? "Expand 16-band equalizer" : "Collapse equalizer";
    this.bypass.textContent = this.bypassed ? "Off" : "On";
    this.bypass.setAttribute("aria-pressed", String(!this.bypassed));
    this.bypass.title = this.bypassed ? "Enable equalizer" : "Bypass equalizer";
    this.bypass.style.color = this.bypassed ? "#9895ad" : "#bd93f9";
    this.bypass.style.borderColor = this.bypassed ? "rgba(189, 147, 249, 0.15)" : "rgba(189, 147, 249, 0.4)";
    this.bypass.style.background = this.bypassed ? "transparent" : "rgba(189, 147, 249, 0.09)";
    for (let index = 0; index < EQ_BANDS.length; index++) this.paintBand(index);
  }
}
