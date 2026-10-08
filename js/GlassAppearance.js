/* Appearance is independent of playback. Only a procedural vector field is
 * rasterized here; no page, video, screenshot, or user content is captured. */
(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEFAULTS = Object.freeze({ style: "liquid", opacity: 45, blur: 16, refraction: 18,
    participants: "comfortable", spectrum: true, reducedMotion: false });
  let sequence = 0;

  class SpaceGlassAppearance {
    constructor(target) {
      if (!(target instanceof Element)) throw new TypeError("A glass window element is required");
      this.target = target;
      this.disposed = false;
      this.revision = 0;
      this.frame = 0;
      this.mapKey = "";
      this.savedAttributes = new Map();
      this.savedProperties = new Map();
      this.hadClass = target.classList.contains("ss-appearance");
      this.api = globalThis.SpaceCastAppearance;
      this.id = "ss-glass-refraction-" + (++sequence);
      // SVG backdrop references currently render consistently in Chromium.
      // Other engines retain ordinary frosted glass instead of a broken URL filter.
      this.svgSupported = /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent) &&
        typeof CSS !== "undefined" && CSS.supports("backdrop-filter", 'url("#' + this.id + '")');
      this.motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
      this.onMotion = () => { if (!this.disposed) this.applyMotion(); };
      this.motion?.addEventListener?.("change", this.onMotion);
      this.createFilter();
      this.layer = document.createElement("div");
      this.layer.className = "ss-glass-lens";
      this.layer.setAttribute("aria-hidden", "true");
      this.layer.setAttribute("role", "presentation");
      target.appendChild(this.layer); // Native X body remains the first child.
      target.classList.add("ss-appearance");
      this.set(this.api?.defaults || DEFAULTS);
      this.unsubscribe = this.api?.subscribe?.(settings => this.set(settings));
      const initialRevision = this.revision;
      this.ready = Promise.resolve().then(() => this.api?.load?.() || DEFAULTS).then(settings => {
        if (!this.disposed && this.revision === initialRevision) this.set(settings);
        return this.settings;
      }).catch(() => this.settings); // The visible default remains usable without storage.
      if (typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(() => this.queueMap());
        this.observer.observe(target);
      }
    }

    node(tag, attributes = {}) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
      return node;
    }

    createFilter() {
      this.svg = this.node("svg", { width: 0, height: 0, "aria-hidden": "true", focusable: "false" });
      this.svg.classList.add("ss-glass-definitions");
      Object.assign(this.svg.style, { position: "fixed", width: "0", height: "0", overflow: "hidden", pointerEvents: "none" });
      const defs = this.node("defs");
      this.filter = this.node("filter", { id: this.id, filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" });
      this.mapImage = this.node("feImage", { x: 0, y: 0, preserveAspectRatio: "none", result: "surface-field" });
      // A byte value of 128 represents a precisely neutral field, not a small
      // displacement across the entire centre of the window.
      const balance = this.node("feComponentTransfer", { in: "surface-field", result: "surface-normal" });
      for (const channel of ["R", "G"]) balance.append(this.node("feFunc" + channel, { type: "linear", slope: 1, intercept: -0.5 / 255 }));
      this.blur = this.node("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 16, edgeMode: "duplicate", result: "frosted" });
      this.displace = this.node("feDisplacementMap", { in: "SourceGraphic", in2: "surface-normal", scale: 36, xChannelSelector: "R", yChannelSelector: "G", result: "refracted" });
      this.polish = this.node("feGaussianBlur", { in: "refracted", stdDeviation: 1.6, edgeMode: "duplicate", result: "polished-rim" });
      const mask = this.node("feColorMatrix", { in: "surface-field", type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0", result: "edge-mask" });
      const core = this.node("feComposite", { in: "frosted", in2: "edge-mask", operator: "out", result: "frosted-core" });
      const edge = this.node("feComposite", { in: "polished-rim", in2: "edge-mask", operator: "in", result: "clear-edge" });
      const merge = this.node("feMerge");
      merge.append(this.node("feMergeNode", { in: "frosted-core" }), this.node("feMergeNode", { in: "clear-edge" }));
      this.filter.append(this.mapImage, balance, this.blur, this.displace, this.polish, mask, core, edge, merge);
      defs.append(this.filter);
      this.svg.append(defs);
      (document.body || document.documentElement).append(this.svg);
      this.mapImage.addEventListener("error", () => {
        if (!this.disposed) { this.svgSupported = false; this.applyFilter(); }
      });
    }

    attribute(name, value) {
      if (!this.savedAttributes.has(name)) this.savedAttributes.set(name, this.target.getAttribute(name));
      this.target.setAttribute(name, String(value));
    }

    property(name, value) {
      if (!this.savedProperties.has(name)) this.savedProperties.set(name, [this.target.style.getPropertyValue(name), this.target.style.getPropertyPriority(name)]);
      this.target.style.setProperty(name, String(value));
    }

    set(value) {
      if (this.disposed) return;
      const settings = this.api?.normalize ? this.api.normalize(value) : { ...DEFAULTS, ...value };
      this.settings = settings;
      this.revision++;
      const sizes = { compact: [28, 10, 9], comfortable: [36, 12, 10], large: [42, 13, 11] }[settings.participants] || [36, 12, 10];
      this.attribute("data-ss-style", settings.style);
      this.attribute("data-ss-participants", settings.participants);
      this.attribute("data-ss-spectrum", settings.spectrum);
      this.property("--ss-glass-opacity", settings.opacity / 100);
      this.property("--ss-glass-blur", settings.blur + "px");
      this.property("--ss-glass-refraction", settings.refraction + "px");
      this.property("--ss-avatar-size", sizes[0] + "px");
      this.property("--ss-name-size", sizes[1] + "px");
      this.property("--ss-role-size", sizes[2] + "px");
      this.blur.setAttribute("stdDeviation", String(settings.blur));
      this.polish.setAttribute("stdDeviation", String(Math.min(2, settings.blur / 10)));
      this.displace.setAttribute("scale", String(settings.refraction * 2));
      this.applyMotion(false);
      this.applyFilter();
      this.queueMap();
      this.notify();
    }

    applyMotion(notify = true) {
      this.attribute("data-ss-motion", this.settings.reducedMotion || this.motion?.matches ? "reduced" : "full");
      // Also notify the visualizer when the operating-system preference changes.
      if (notify && this.revision > 0) this.notify();
    }

    notify() {
      this.target.dispatchEvent(new CustomEvent("spacecast:appearancechange", { detail: {
        ...this.settings, reducedMotion: this.settings.reducedMotion || !!this.motion?.matches,
      } }));
    }

    applyFilter() {
      const liquid = this.settings.style === "liquid";
      const active = liquid && this.svgSupported && this.settings.refraction > 0 && this.mapKey !== "";
      this.attribute("data-ss-refraction", active ? "svg" : this.settings.style === "solid" ? "none" : "blur");
      this.property("--ss-glass-filter", active ? 'url("#' + this.id + '")' : "blur(" + this.settings.blur + "px)");
    }

    queueMap() {
      if (this.disposed || this.frame || !this.svgSupported || this.settings.style !== "liquid") return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (!this.disposed) this.updateMap();
      });
    }

    updateMap() {
      const rect = this.target.getBoundingClientRect();
      const width = Math.round(rect.width), height = Math.round(rect.height);
      if (width < 2 || height < 2) return;
      const radius = Math.min(parseFloat(getComputedStyle(this.target).borderTopLeftRadius) || 24, width / 2, height / 2);
      const key = [width, height, radius].join(":");
      if (key === this.mapKey) return;
      const ratio = Math.min(1, 720 / Math.max(width, height));
      const columns = Math.max(2, Math.round(width * ratio)), rows = Math.max(2, Math.round(height * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = columns;
      canvas.height = rows;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) { this.svgSupported = false; this.applyFilter(); return; }
      const image = context.createImageData(columns, rows);
      const pixels = image.data;
      const edgeWidth = Math.min(30, Math.max(18, radius * 1.1), width / 3, height / 3);
      const cx = width / 2, cy = height / 2, flatX = cx - radius, flatY = cy - radius;
      // A rounded cross-section changes the surface normal through its rim.
      // Snell's law (air -> glass, n=1.45) supplies the sampling displacement.
      // The flat centre has zero normal offset; corners follow the rounded SDF.
      const profile = new Float32Array(256);
      let peak = 0;
      for (let index = 0; index < profile.length; index++) {
        const t = index / 255, q = 1 - t, sag = Math.sqrt(Math.max(0, 1 - q * q));
        const incidence = Math.atan2(q, Math.max(0.0001, sag));
        const refracted = Math.asin(Math.sin(incidence) / 1.45);
        profile[index] = Math.tan(incidence - refracted) * sag;
        peak = Math.max(peak, profile[index]);
      }
      for (let y = 0, offset = 0; y < rows; y++) {
        const dy = (y + 0.5) * height / rows - cy, qy = Math.abs(dy) - flatY;
        for (let x = 0; x < columns; x++, offset += 4) {
          const dx = (x + 0.5) * width / columns - cx, qx = Math.abs(dx) - flatX;
          const ox = Math.max(qx, 0), oy = Math.max(qy, 0), length = Math.sqrt(ox * ox + oy * oy);
          const distance = radius - length - Math.min(Math.max(qx, qy), 0);
          let red = 128, green = 128, rim = 0;
          if (distance >= 0 && distance < edgeWidth) {
            const t = distance / edgeWidth;
            const bend = profile[Math.min(255, Math.round(t * 255))] / peak;
            const nx = length > 0 ? ox / length * Math.sign(dx) : qx > qy ? Math.sign(dx) : 0;
            const ny = length > 0 ? oy / length * Math.sign(dy) : qy >= qx ? Math.sign(dy) : 0;
            red += nx * bend * 127;
            green += ny * bend * 127;
            const fade = 1 - t;
            rim = 255 * fade * fade * (3 - 2 * fade);
          }
          pixels[offset] = red; pixels[offset + 1] = green; pixels[offset + 2] = rim; pixels[offset + 3] = 255;
        }
      }
      context.putImageData(image, 0, 0);
      for (const [name, value] of Object.entries({ x: -40, y: -40, width: width + 80, height: height + 80 })) this.filter.setAttribute(name, String(value));
      this.mapImage.setAttribute("width", String(width));
      this.mapImage.setAttribute("height", String(height));
      this.mapImage.setAttribute("href", canvas.toDataURL("image/png"));
      this.mapKey = key;
      this.applyFilter();
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.observer?.disconnect();
      this.unsubscribe?.();
      this.motion?.removeEventListener?.("change", this.onMotion);
      this.layer.remove();
      this.svg.remove();
      for (const [name, value] of this.savedAttributes) value === null ? this.target.removeAttribute(name) : this.target.setAttribute(name, value);
      for (const [name, [value, priority]] of this.savedProperties) value ? this.target.style.setProperty(name, value, priority) : this.target.style.removeProperty(name);
      if (!this.hadClass) this.target.classList.remove("ss-appearance");
    }
  }
  globalThis.SpaceGlassAppearance = SpaceGlassAppearance;
})();
