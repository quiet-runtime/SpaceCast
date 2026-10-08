/* X's operation IDs change independently of extension releases. Reuse only the
 * shape of AudioSpaceById requests already made by this signed-in page. */
class SpaceCastApi {
  constructor(signal) {
    this.signal = signal;
    this.ORIGIN = location.origin;
    this.AUTHORIZATION = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
    this.requestedUrls = new Set();
  }

  getCookieArray() {
    const cookies = Object.create(null);
    for (const part of document.cookie.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      const name = part.slice(0, separator).trim();
      if (name !== "ct0" && name !== "gt") continue;
      try {
        const value = decodeURIComponent(part.slice(separator + 1));
        if (value && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value)) cookies[name] = value;
      } catch (_) { /* A malformed unrelated cookie must not break playback. */ }
    }
    return cookies;
  }

  getHeaders() {
    const cookie = this.getCookieArray();
    const headers = {
      authorization: this.AUTHORIZATION,
      "Content-type": "application/json",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
    };
    // A leftover guest token must not override the signed-in session.
    if (cookie.ct0) headers["x-csrf-token"] = cookie.ct0;
    else if (cookie.gt) headers["x-guest-token"] = cookie.gt;
    return headers;
  }

  _checkAbort() {
    if (this.signal?.aborted) throw this.signal.reason || new DOMException("Opening this Space was cancelled", "AbortError");
  }

  _parameters(raw, flagsOnly = false) {
    if (!raw || raw.length > 32768) return null;
    try {
      const input = JSON.parse(raw);
      if (!input || typeof input !== "object" || Array.isArray(input)) return null;
      const entries = Object.entries(input);
      if (entries.length > 256) return null;
      const result = Object.create(null);
      for (const [key, value] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,159}$/.test(key) || ["constructor", "prototype", "__proto__"].includes(key)) continue;
        if (typeof value === "boolean" || (!flagsOnly && ((typeof value === "string" && value.length <= 1024) || (typeof value === "number" && Number.isFinite(value))))) result[key] = value;
      }
      return result;
    } catch (_) { return null; }
  }

  _nativeTemplate() {
    if (!/^https:\/\/(?:x|twitter)\.com$/.test(this.ORIGIN)) return null;
    let entries;
    try { entries = performance.getEntriesByType("resource"); } catch (_) { return null; }
    // No observer, network interception, persistent token storage, or polling.
    for (let i = entries.length - 1, end = Math.max(0, entries.length - 300); i >= end; i--) {
      const name = entries[i].name;
      if (typeof name !== "string" || name.length > 100000 || this.requestedUrls.has(name)) continue;
      try {
        const url = new URL(name);
        if (url.origin !== this.ORIGIN || url.username || url.password || !/^\/i\/api\/graphql\/[A-Za-z0-9_-]{8,80}\/AudioSpaceById$/.test(url.pathname)) continue;
        const variables = this._parameters(url.searchParams.get("variables"));
        if (!variables || typeof variables.id !== "string") continue;
        return {
          path: url.pathname,
          variables,
          features: this._parameters(url.searchParams.get("features"), true),
          fieldToggles: this._parameters(url.searchParams.get("fieldToggles"), true),
        };
      } catch (_) { /* Ignore malformed or unrelated resource names. */ }
    }
    return null;
  }

  _legacyTemplate() {
    return {
      path: "/i/api/graphql/Uv5R_-Chxbn1FEkyUkSW2w/AudioSpaceById",
      variables: {
        isMetatagsQuery: true,
        withSuperFollowsUserFields: true,
        withBirdwatchPivots: false,
        withDownvotePerspective: false,
        withReactionsMetadata: false,
        withReactionsPerspective: false,
        withSuperFollowsTweetFields: true,
        withReplays: true,
        withScheduledSpaces: true,
      },
    };
  }

  _metadataUrl(template, id) {
    const url = new URL(template.path, this.ORIGIN);
    url.searchParams.set("variables", JSON.stringify({ ...template.variables, id }));
    for (const key of ["features", "fieldToggles"]) {
      if (template[key]) url.searchParams.set(key, JSON.stringify(template[key]));
    }
    return url.toString();
  }

  async _request(url, stage) {
    this._checkAbort();
    // Keep only a bounded list so our own requests cannot become native templates.
    this.requestedUrls.add(url);
    if (this.requestedUrls.size > 64) this.requestedUrls.delete(this.requestedUrls.values().next().value);
    let response;
    try {
      response = await fetch(url, { headers: this.getHeaders(), method: "GET", credentials: "same-origin", signal: this.signal });
    } catch (error) {
      this._checkAbort();
      if (error?.name === "AbortError") throw error;
      throw new Error(stage + ": could not reach X. Check your connection and retry.");
    }
    this._checkAbort();
    if (!response.ok) {
      const hints = { 401: " Sign in to X and retry.", 403: " X denied access to this Space.", 404: " X could not find this Space or its endpoint.", 429: " X is rate limiting requests. Wait before retrying." };
      const error = new Error(stage + ": X HTTP " + response.status + (hints[response.status] || " Please retry shortly."));
      error.status = response.status;
      throw error;
    }
    try {
      const data = await response.json();
      this._checkAbort();
      return data;
    } catch (error) {
      this._checkAbort();
      throw new Error(stage + ": X returned an unreadable response. Please retry.");
    }
  }

  _unavailable(data, stage) {
    const detail = typeof data?.errors?.[0]?.message === "string" ? data.errors[0].message.replace(/[\x00-\x1f]/g, " ").slice(0, 240) : "No playable data was returned by X.";
    return new Error(stage + ": " + detail);
  }

  async AudioSpaceById(id) {
    this._checkAbort();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Space details: invalid Space ID");
    const template = this._nativeTemplate() || this._legacyTemplate();
    const url = this._metadataUrl(template, id);
    let data;
    try {
      data = await this._request(url, "Space details");
    } catch (error) {
      if (error.status !== 404 || this.signal?.aborted) throw error;
      // One retry only, and only when a different operation is available.
      const fresh = this._nativeTemplate();
      const refreshedUrl = fresh && this._metadataUrl(fresh, id);
      const retryUrl = refreshedUrl && refreshedUrl !== url ? refreshedUrl : this._metadataUrl(this._legacyTemplate(), id);
      if (retryUrl === url) throw error;
      data = await this._request(retryUrl, "Space details");
    }
    // GraphQL may return optional-field errors alongside usable Space metadata.
    const metadata = data?.data?.audioSpace?.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !Object.keys(metadata).length) throw this._unavailable(data, "Space details");
    return data;
  }

  async live_video_stream(media_key) {
    if (typeof media_key !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(media_key)) throw new Error("Audio stream: invalid media key");
    const url = new URL("/i/api/1.1/live_video_stream/status/" + encodeURIComponent(media_key), this.ORIGIN);
    url.searchParams.set("client", "web");
    url.searchParams.set("use_syndication_guest_id", "false");
    url.searchParams.set("cookie_set_host", "twitter.com");
    const data = await this._request(url.toString(), "Audio stream");
    if (!data?.source?.location) throw this._unavailable(data, "Audio stream");
    return data;
  }
}
