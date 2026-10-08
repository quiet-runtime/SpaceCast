(() => {
  const api = globalThis.SpaceCastAppearance;
  const form = document.getElementById("appearance-form");
  const fields = document.getElementById("settings-fields");
  const status = document.getElementById("save-status");
  const preview = document.getElementById("appearance-preview");
  const names = { liquid: "Liquid glass", dracula: "Dracula", oled: "OLED", solid: "Solid" };
  const renderer = typeof SpaceGlassAppearance === "function" ? new SpaceGlassAppearance(preview) : null;
  let settings = api.normalize(api.defaults);
  let pending = {};
  let timer = null;
  let saving = 0;
  let sequence = 0;
  let disposed = false;

  function report(message, state = "saved") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function render(value) {
    settings = api.normalize(value);
    form.elements.namedItem("style").value = settings.style;
    for (const name of ["opacity", "blur", "refraction"]) {
      document.getElementById(name).value = settings[name];
      document.getElementById(name + "-value").value = settings[name] + (name === "opacity" ? "%" : name === "blur" ? " px" : "");
    }
    document.getElementById("participants").value = settings.participants;
    document.getElementById("spectrum").checked = settings.spectrum;
    document.getElementById("reducedMotion").checked = settings.reducedMotion;
    document.getElementById("opacity").disabled = settings.style === "solid";
    document.getElementById("blur").disabled = settings.style === "solid";
    document.getElementById("refraction").disabled = settings.style !== "liquid";
    document.getElementById("surface-note").textContent = settings.style === "solid"
      ? "Solid uses an opaque surface with no background filters."
      : settings.style === "liquid" ? "Refraction bends the background near the glass edges."
      : "Refraction is available with Liquid glass. Your preferred strength is kept.";
    document.getElementById("preview-style-name").textContent = names[settings.style];
    preview.querySelector(".preview-spectrum").hidden = !settings.spectrum;
    preview.querySelector(".preview-spectrum").style.setProperty("display", settings.spectrum ? "flex" : "none", "important");
    renderer?.set(settings);
  }

  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (!Object.keys(pending).length) return;
    const patch = pending;
    pending = {};
    const request = ++sequence;
    saving++;
    report("Saving…", "saving");
    try {
      const saved = await api.save(patch);
      if (!disposed && request === sequence) {
        render({ ...saved, ...pending });
        report(Object.keys(pending).length ? "Saving…" : "Saved · applies to open Spaces", Object.keys(pending).length ? "saving" : "saved");
      }
    } catch (error) {
      if (!disposed && request === sequence) report("Couldn’t save. " + (error.message || "Try again."), "error");
    } finally { saving--; }
  }

  function update(patch, immediate) {
    pending = { ...pending, ...patch };
    render({ ...settings, ...patch });
    report("Saving…", "saving");
    clearTimeout(timer);
    if (immediate) void flush();
    else timer = setTimeout(flush, 150);
  }

  form.addEventListener("submit", event => event.preventDefault());
  for (const name of ["opacity", "blur", "refraction"]) {
    const slider = document.getElementById(name);
    slider.addEventListener("input", () => update({ [name]: Number(slider.value) }, false));
    slider.addEventListener("change", () => update({ [name]: Number(slider.value) }, true));
  }
  for (const radio of document.querySelectorAll('input[name="style"]')) radio.addEventListener("change", () => { if (radio.checked) update({ style: radio.value }, true); });
  document.getElementById("participants").addEventListener("change", event => update({ participants: event.target.value }, true));
  for (const name of ["spectrum", "reducedMotion"]) document.getElementById(name).addEventListener("change", event => update({ [name]: event.target.checked }, true));
  document.getElementById("reset").addEventListener("click", () => update({ ...api.defaults }, true));

  const unsubscribe = api.subscribe(value => {
    if (!disposed && !saving && !Object.keys(pending).length) {
      render(value);
      report("Saved · applies to open Spaces");
    }
  });
  render(settings);
  Promise.resolve(renderer?.ready).then(() => { if (!disposed) renderer?.set(settings); });
  api.load().then(value => { render(value); report("Changes save automatically"); }).catch(error => {
    report(error.message || "Settings are unavailable. Reload this page to retry.", "error");
  }).finally(() => { fields.disabled = false; });
  window.addEventListener("pagehide", () => {
    void flush();
    disposed = true;
    unsubscribe();
    renderer?.dispose();
  }, { once: true });
})();
