// A session DVR: playlist polling and segment capture never depend on the
// media element's position, paused state, or hls.js's forward-buffer limit.
// Prefer IndexedDB; a broken browser database must never prevent playback.
// The fallback is deliberately bounded and advertises a sliding rewind window.
class SpaceCacheStore {
  constructor(options = {}) {
    this.name = "spacecast-session-" + crypto.randomUUID();
    this.closed = false;
    this.mode = "opening";
    this.reason = "";
    this.db = null;
    this.memory = new Map();
    this.bytes = 0;
    this.maxBytes = options.maxBytes ?? 32 * 1048576;
    this.timeout = options.timeout ?? 2000;
    this.indexedDB = options.indexedDB ?? globalThis.indexedDB;
    this.ready = new Promise(resolve => {
      this.finishOpen = resolve;
      this.openTimer = setTimeout(() => this.fallback("Storage did not respond"), this.timeout);
      try {
        const request = this.indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          if (this.closed || this.mode !== "opening") { request.transaction.abort(); return; }
          request.result.createObjectStore("segments");
        };
        request.onerror = () => this.fallback(request.error?.name || "Storage unavailable");
        request.onblocked = () => this.fallback("Storage is busy");
        request.onsuccess = () => {
          if (this.closed || this.mode !== "opening") {
            request.result.close();
            if (this.closed) this.deleteSession();
            return;
          }
          this.db = request.result;
          this.db.onversionchange = () => this.fallback("Storage changed");
          this.mode = "disk";
          clearTimeout(this.openTimer);
          resolve(this.db);
        };
      } catch (error) { this.fallback(error.name || "Storage unavailable"); }
    });
  }

  fallback(reason) {
    if (this.closed || this.mode === "memory") return;
    clearTimeout(this.openTimer);
    this.mode = "memory";
    this.reason = reason;
    this.db?.close();
    this.db = null;
    this.finishOpen?.(null);
    this.onfallback?.();
  }

  async run(mode, operation) {
    const db = await this.ready;
    if (this.closed) throw new Error("Cache closed");
    if (this.mode !== "disk" || !db) throw new Error("Disk cache unavailable");
    return new Promise((resolve, reject) => {
      let tx, request;
      const timer = setTimeout(() => {
        try { tx?.abort(); } catch (_) { /* already complete */ }
        reject(new Error("Storage did not respond"));
      }, this.timeout);
      const finish = (callback, value) => { clearTimeout(timer); callback(value); };
      try {
        tx = db.transaction("segments", mode);
        request = operation(tx.objectStore("segments"));
        tx.oncomplete = () => finish(resolve, request.result);
        tx.onerror = tx.onabort = () => finish(reject, tx.error || request.error || new Error("Cache write failed"));
      } catch (error) { finish(reject, error); }
    });
  }

  async get(key) {
    await this.ready;
    if (this.closed) throw new Error("Cache closed");
    if (this.mode === "disk") {
      try { return await this.run("readonly", store => store.get(key)); }
      catch (error) { this.fallback(error.name || "Storage read failed"); }
    }
    return this.memory.get(key)?.data;
  }

  async put(key, data, priority = Number.MAX_SAFE_INTEGER) {
    await this.ready;
    if (this.closed) throw new Error("Cache closed");
    if (this.mode === "disk") {
      try {
        await this.run("readwrite", store => store.put(data, key));
        if (this.mode === "disk") return true;
        // Another concurrent transaction may have triggered the fallback while
        // this write completed. Keep these bytes in the active store as well.
      }
      catch (error) { this.fallback(error.name || "Storage write failed"); }
    }
    if (this.closed) throw new Error("Cache closed");
    this.remove(key);
    this.memory.set(key, { data, priority });
    this.bytes += data.byteLength;
    // Evict by media sequence, rather than completion order: concurrent or
    // slow downloads must not replace newer live audio with older backfill.
    while (this.bytes > this.maxBytes && this.memory.size) {
      let oldest;
      for (const entry of this.memory) if (!oldest || entry[1].priority < oldest[1].priority) oldest = entry;
      this.remove(oldest[0]);
      this.onevict?.(oldest[0]);
    }
    return this.memory.has(key);
  }

  remove(key) {
    const item = this.memory.get(key);
    if (item) { this.bytes -= item.data.byteLength; this.memory.delete(key); }
  }

  deleteSession() {
    // Never clear the site's storage or recording databases, only our UUID.
    try { this.indexedDB?.deleteDatabase(this.name); } catch (_) { /* browser storage unavailable */ }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.openTimer);
    this.finishOpen?.(null);
    this.db?.close();
    this.db = null;
    this.memory.clear();
    this.bytes = 0;
    this.deleteSession();
  }
}

function parseDvrPlaylist(text, base) {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Invalid audio playlist");
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const result = { segments: [], target: 3, sequence: 0, discontinuity: 0, version: 3, ended: false };
  let duration = 0, sequence = 0, cc = 0, tags = [], key = null, map = null, range = null;
  let previousRange = null;
  const absolute = uri => new URL(uri, base).href;
  const rewrite = line => line.replace(/URI="([^"]+)"/g, (_, uri) => 'URI="' + absolute(uri) + '"');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const media = lines.find(candidate => candidate.startsWith("#EXT-X-MEDIA:") &&
        candidate.includes("TYPE=AUDIO") && /URI="/.test(candidate));
      result.variant = media ? absolute(/URI="([^"]+)"/.exec(media)[1]) : absolute(lines[i + 1]);
      return result;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) sequence = result.sequence = Number(line.split(":")[1]);
    else if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) cc = result.discontinuity = Number(line.split(":")[1]);
    else if (line.startsWith("#EXT-X-TARGETDURATION:")) result.target = Number(line.split(":")[1]) || 3;
    else if (line.startsWith("#EXT-X-VERSION:")) result.version = Number(line.split(":")[1]) || 3;
    else if (line === "#EXT-X-ENDLIST") result.ended = true;
    else if (line.startsWith("#EXT-X-KEY:")) key = rewrite(line);
    else if (line.startsWith("#EXT-X-MAP:")) map = rewrite(line);
    else if (line.startsWith("#EXT-X-BYTERANGE:")) range = line.slice(17);
    else if (line === "#EXT-X-DISCONTINUITY") cc++;
    else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:") || line === "#EXT-X-GAP") tags.push(line);
    else if (line.startsWith("#EXTINF:")) duration = parseFloat(line.slice(8));
    else if (!line.startsWith("#")) {
      const url = absolute(line);
      let start, end;
      if (range) {
        const [length, offset] = range.split("@").map(Number);
        start = offset ?? (previousRange?.url === url ? previousRange.end : NaN);
        if (!Number.isFinite(start)) throw new Error("Invalid audio byte range");
        end = start + length;
        previousRange = { url, end };
      }
      result.segments.push({ url, start, end, duration: duration || result.target,
        sequence: sequence++, cc, key, map, tags });
      duration = 0; range = null; tags = [];
    }
  }
  return result;
}

class SpaceLiveCache {
  constructor(url, options = {}) {
    this.url = url;
    this.sourceUrl = url;
    this.store = options.store || new SpaceCacheStore();
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.onchange = options.onchange || (() => {});
    this.segments = new Map();
    this.resources = new Map();
    this.pending = new Map();
    this.controllers = new Set();
    this.active = true;
    this.ended = false;
    this.target = 3;
    this.version = 3;
    this.bytes = 0;
    this.seconds = 0;
    this.error = "";
    this.storageError = "";
    this.missing = 0;
    this.timer = null;
    this.queueTimer = null;
    this.floor = -Infinity;
    this.latestFirst = -Infinity;
    this.store.onfallback = () => {
      // Disk history is no longer reliable. Start a truthful limited window
      // from the current upstream playlist, without clearing any recordings.
      for (const resource of this.resources.values()) { resource.saved = false; resource.size = 0; }
      this.bytes = 0;
      this.trimBefore(this.latestFirst);
      this.limitMemoryWindow();
      this.onchange();
    };
    this.store.onevict = id => {
      const resource = this.resources.get(id);
      if (!resource) return;
      resource.saved = false;
      resource.retired = true;
      this.bytes = Math.max(0, this.bytes - (resource.size || 0));
      resource.size = 0;
      const affected = [...this.segments.values()].filter(segment => segment.resource === resource || segment.dependencies?.includes(id));
      if (affected.length) {
        const last = Math.max(...affected.map(segment => segment.sequence));
        const newest = Math.max(...this.segments.keys());
        this.trimBefore(Math.min(last + 1, newest));
      }
      this.onchange();
    };
  }

  trimBefore(sequence) {
    this.floor = Math.max(this.floor, sequence);
    for (const [sn] of this.segments) if (sn < this.floor) this.segments.delete(sn);
    const retained = new Set();
    for (const segment of this.segments.values()) {
      retained.add(segment.resource.id);
      for (const id of segment.dependencies || []) retained.add(id);
    }
    for (const [id, resource] of this.resources) {
      if (retained.has(id)) continue;
      resource.retired = true;
      this.bytes = Math.max(0, this.bytes - (resource.size || 0));
      resource.size = 0;
      resource.saved = false;
      this.store.remove?.(id);
      this.resources.delete(id);
    }
    this.updateWindow();
  }

  updateWindow() {
    const ordered = [...this.segments.values()].sort((a, b) => a.sequence - b.sequence);
    this.seconds = ordered.reduce((seconds, item) => seconds + item.duration, 0);
    this.missing = ordered.reduce((count, item, index) => count + (index ? Math.max(0, item.sequence - ordered[index - 1].sequence - 1) : 0), 0);
  }

  limitMemoryWindow() {
    if (this.store.mode !== "memory") return;
    const ordered = [...this.segments.values()].sort((a, b) => b.sequence - a.sequence);
    let seconds = 0, count = 0, first;
    for (const segment of ordered) {
      if (count && (count >= 300 || seconds + segment.duration > 900)) break;
      seconds += segment.duration; count++; first = segment.sequence;
    }
    if (first != null) this.trimBefore(first);
  }

  resource(url, start, end) {
    if (end == null || end === 0) { start = undefined; end = undefined; }
    const id = JSON.stringify([url, start ?? null, end ?? null]);
    if (!this.resources.has(id)) this.resources.set(id, { id, url, start, end, saved: false, retryAt: 0 });
    return this.resources.get(id);
  }

  async request(url, start, end, text = false) {
    if (!this.active) throw new Error("Cache closed");
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = end == null ? {} : { Range: `bytes=${start}-${end - 1}` };
      const response = await this.fetch(url, { credentials: "omit", cache: "no-store", headers, signal: controller.signal });
      if (!response.ok) throw new Error("Audio HTTP " + response.status);
      if (text) return await response.text();
      let data = await response.arrayBuffer();
      if (end != null && response.status !== 206) data = data.slice(start, end);
      if (!data.byteLength) throw new Error("Empty audio segment");
      return data;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  async capture(resource) {
    if (!this.active) throw new Error("Cache closed");
    if (resource.saved) {
      const bytes = await this.store.get(resource.id);
      if (bytes != null) return bytes;
      this.bytes = Math.max(0, this.bytes - (resource.size || 0));
      resource.size = 0;
      resource.saved = false;
      if (this.store.mode !== "memory") this.storageError = "Cached audio was removed by the browser";
    }
    if (this.pending.has(resource.id)) return this.pending.get(resource.id);
    const job = (async () => {
      const bytes = await this.request(resource.url, resource.start, resource.end);
      if (!this.active) throw new Error("Cache closed");
      let saved = false;
      try { if (!resource.retired) saved = await this.store.put(resource.id, bytes, resource.sequence); }
      catch (error) {
        this.storageError = "Audio cache storage failed: " + (error.name || "unknown error");
        this.onchange();
        // The downloaded bytes are still playable even if a custom store fails.
      }
      if (!this.active) throw new Error("Cache closed");
      resource.saved = !resource.retired && saved !== false;
      if (resource.retired) this.store.remove?.(resource.id);
      if (!resource.saved) resource.retryAt = Date.now() + 2000;
      if (resource.saved) { resource.size = bytes.byteLength; this.bytes += bytes.byteLength; }
      this.onchange();
      return bytes;
    })();
    this.pending.set(resource.id, job);
    try { return await job; }
    finally { this.pending.delete(resource.id); }
  }

  ingest(playlist) {
    this.target = Math.max(this.target, playlist.target);
    this.version = Math.max(this.version, playlist.version);
    this.ended = playlist.ended;
    this.latestFirst = playlist.segments[0]?.sequence ?? this.latestFirst;
    for (const segment of playlist.segments) {
      if (segment.sequence < this.floor || this.segments.has(segment.sequence)) continue;
      segment.resource = this.resource(segment.url, segment.start, segment.end);
      segment.resource.sequence = segment.sequence;
      segment.dependencies = [];
      for (const tag of [segment.key, segment.map]) {
        const uri = tag && /URI="([^"]+)"/.exec(tag);
        if (!uri) continue;
        const range = /BYTERANGE="(\d+)(?:@(\d+))?"/.exec(tag);
        const start = range ? Number(range[2] || 0) : undefined;
        segment.dependencies.push(this.resource(uri[1], start, range ? start + Number(range[1]) : undefined).id);
      }
      this.segments.set(segment.sequence, segment);
      this.seconds += segment.duration;
    }
    this.limitMemoryWindow();
    this.updateWindow();
    this.onchange();
    this.drain();
  }

  // Download workers do not block playlist polling. A slow or failed segment
  // must never prevent us from discovering and retaining newer live segments.
  drain() {
    clearTimeout(this.queueTimer);
    if (!this.active) return;
    const queue = [...this.resources.values()].reverse().filter(item => !item.saved && !item.retired && !this.pending.has(item.id) && item.retryAt <= Date.now());
    for (const item of queue.slice(0, Math.max(0, 4 - this.pending.size))) {
      this.capture(item).catch(() => { item.retryAt = Date.now() + 2000; }).finally(() => this.drain());
    }
    this.queueTimer = setTimeout(() => this.drain(), 1000);
  }

  async poll() {
    let playlist;
    for (let depth = 0; depth < 5; depth++) {
      playlist = parseDvrPlaylist(await this.request(this.url, undefined, undefined, true), this.url);
      if (!this.active) return;
      if (!playlist.variant) break;
      this.url = playlist.variant;
    }
    if (playlist.variant) throw new Error("Audio playlist redirects in a loop");
    if (!playlist.segments.length) throw new Error("Audio has not started yet");
    this.ingest(playlist);
    this.error = "";
  }

  async start() {
    await this.store.ready;
    await this.poll();
    this.schedule();
    return this;
  }

  schedule() {
    if (!this.active || this.ended) return;
    this.timer = setTimeout(async () => {
      try { await this.poll(); }
      catch (error) {
        if (this.active) { this.error = "Live connection interrupted; retrying"; this.onchange(); }
      }
      this.schedule();
    }, Math.min(3000, Math.max(500, this.target * 500)));
  }

  playlist() {
    const items = [...this.segments.values()].sort((a, b) => a.sequence - b.sequence);
    if (!items.length) throw new Error("Audio cache is still starting");
    const lines = ["#EXTM3U", "#EXT-X-VERSION:" + Math.max(6, this.version),
      "#EXT-X-TARGETDURATION:" + Math.ceil(this.target),
      "#EXT-X-MEDIA-SEQUENCE:" + items[0].sequence,
      "#EXT-X-DISCONTINUITY-SEQUENCE:" + items[0].cc];
    if (this.store.mode !== "memory") lines.splice(3, 0, "#EXT-X-PLAYLIST-TYPE:EVENT");
    let cc = items[0].cc, key = null, map = null, previous = null;
    for (const item of items) {
      // Explicit GAP entries keep sequence numbers and implicit AES IVs aligned
      // if the network went away for longer than the server's playlist window.
      for (let sn = previous == null ? item.sequence : previous + 1; sn < item.sequence; sn++) {
        lines.push("#EXT-X-GAP", "#EXTINF:" + this.target + ",", new URL("spacecast-missing-" + sn + ".aac", this.url).href);
      }
      while (cc < item.cc) { lines.push("#EXT-X-DISCONTINUITY"); cc++; }
      if (item.key !== key) { if (item.key) lines.push(item.key); else if (key) lines.push("#EXT-X-KEY:METHOD=NONE"); key = item.key; }
      if (item.map !== map) { if (item.map) lines.push(item.map); map = item.map; }
      lines.push(...item.tags, "#EXTINF:" + item.duration + ",");
      if (item.end != null) lines.push(`#EXT-X-BYTERANGE:${item.end - item.start}@${item.start}`);
      lines.push(item.url);
      previous = item.sequence;
    }
    if (this.ended) lines.push("#EXT-X-ENDLIST");
    return lines.join("\n") + "\n";
  }

  loaderClass(BaseLoader) {
    const cache = this;
    return class extends BaseLoader {
      load(context, config, callbacks) {
        this.callbacks = callbacks;
        this.completed = false;
        const isPlaylist = context.type === "manifest" || context.type === "level";
        const resource = isPlaylist ? null : cache.resource(context.url, context.rangeStart, context.rangeEnd);
        this.context = context;
        this.stats.loading.start = performance.now();
        const job = isPlaylist ? Promise.resolve().then(() => cache.playlist()) : cache.capture(resource);
        job.then(data => {
          if (this.stats.aborted || !cache.active) return;
          this.stats.loading.first = this.stats.loading.end = performance.now();
          this.stats.loaded = this.stats.total = typeof data === "string" ? data.length : data.byteLength;
          this.completed = true;
          if (typeof data !== "string") callbacks.onProgress?.(this.stats, context, data, null);
          callbacks.onSuccess({ url: isPlaylist ? cache.url : context.url, data }, this.stats, context, null);
        }).catch(error => {
          if (!this.stats.aborted && cache.active) callbacks.onError({ code: 0, text: error.message }, context, null);
        });
      }
      // A seek cancels this consumer only. It must not abort shared capture.
      abort() {
        if (this.completed || this.stats.aborted) return;
        this.stats.aborted = true;
        this.callbacks?.onAbort?.(this.stats, this.context, null);
      }
      destroy() {
        // hls.js destroys successful loaders before processing their result.
        // Marking that completed result aborted would discard every fragment.
        if (!this.completed) this.stats.aborted = true;
        this.callbacks = null;
      }
    };
  }

  status() {
    const unsaved = [...this.resources.values()].filter(item => !item.saved && !item.retired).length;
    const warning = this.storageError || this.error || (this.missing ? this.missing + " segments missed during connection loss" : "");
    const temporary = this.store.mode === "memory";
    return (temporary ? "temporary rewind " : this.ended ? "cached " : "live cache ") + Math.floor(this.seconds / 60) + "m · " +
      (this.bytes / 1048576).toFixed(1) + " MB" + (unsaved ? " · " + unsaved + " pending" : "") +
      (temporary ? " · browser storage unavailable; limited to 15m / 32 MB" : "") + (warning ? " · " + warning : "");
  }

  destroy() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    clearTimeout(this.queueTimer);
    for (const controller of this.controllers) controller.abort();
    this.store.close().catch(() => {});
    this.resources.clear();
    this.segments.clear();
  }
}
