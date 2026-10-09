/* Shared by the native Space renderer and the extension's graphics page. */
(() => {
  const key = "spacecast.appearance";
  const defaults = Object.freeze({
    style: "liquid", opacity: 45, blur: 16, refraction: 18,
    participants: "comfortable", spectrum: true, reducedMotion: false, relationshipBadges: true,
  });
  const number = (value, fallback, min, max) => typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

  function normalize(value) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      style: ["liquid", "dracula", "oled", "solid"].includes(input.style) ? input.style : defaults.style,
      opacity: number(input.opacity, defaults.opacity, 20, 90),
      blur: number(input.blur, defaults.blur, 0, 30),
      refraction: number(input.refraction, defaults.refraction, 0, 40),
      participants: ["compact", "comfortable", "large"].includes(input.participants) ? input.participants : defaults.participants,
      spectrum: typeof input.spectrum === "boolean" ? input.spectrum : defaults.spectrum,
      reducedMotion: typeof input.reducedMotion === "boolean" ? input.reducedMotion : defaults.reducedMotion,
      relationshipBadges: input.relationshipBadges !== false,
    };
  }

  const extension = () => globalThis.chrome || globalThis.browser;
  function storageCall(method, value) {
    const api = extension();
    if (!api?.storage?.local?.[method]) return Promise.reject(new Error("Extension storage is unavailable. Reload SpaceCast and try again."));
    if (!globalThis.chrome && globalThis.browser) {
      return Promise.resolve().then(() => api.storage.local[method](value));
    }
    return new Promise((resolve, reject) => {
      try {
        api.storage.local[method](value, result => {
          const error = api.runtime?.lastError;
          if (error) reject(new Error(error.message || "Extension storage is unavailable."));
          else resolve(result);
        });
      } catch (error) { reject(new Error(error?.message || "Extension storage is unavailable.")); }
    });
  }

  async function load() {
    const stored = await storageCall("get", key);
    return normalize(stored?.[key]);
  }

  // Serialize read/merge/write so rapid slider and checkbox changes cannot
  // overwrite one another with an earlier read of the same settings object.
  let writes = Promise.resolve();
  function save(patch) {
    const update = patch && typeof patch === "object" && !Array.isArray(patch) ? { ...patch } : {};
    const operation = writes.catch(() => {}).then(async () => {
      const settings = normalize({ ...await load(), ...update });
      await storageCall("set", { [key]: settings });
      return settings;
    });
    writes = operation;
    return operation;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Appearance subscriber must be a function");
    const changed = extension()?.storage?.onChanged;
    if (!changed?.addListener) return () => {};
    const receive = (changes, area) => {
      if (area === "local" && Object.prototype.hasOwnProperty.call(changes, key)) listener(normalize(changes[key]?.newValue));
    };
    changed.addListener(receive);
    return () => changed.removeListener(receive);
  }

  globalThis.SpaceCastAppearance = Object.freeze({ defaults, normalize, load, save, subscribe });
})();
