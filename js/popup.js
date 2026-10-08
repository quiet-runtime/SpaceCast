document.getElementById("graphics-settings").addEventListener("click", event => {
  const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
  if (!runtime?.openOptionsPage) return;
  event.preventDefault();
  const result = runtime.openOptionsPage();
  result?.catch(() => window.open(runtime.getURL("html/options.html"), "_blank", "noopener"));
});
