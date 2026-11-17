/* Included only by pack:environment-preview. No real environment/install calls. */
(function (root) {
  "use strict";
  function simulation(now = () => Date.now()) {
    const ready = {ffmpeg: false, webview2: false};
    let install = {phase: "idle", component: null, exitCode: null}, finishesAt = 0;
    function update() {
      if (install.phase === "running" && now() >= finishesAt) {
        ready[install.component] = true;
        install = {...install, phase: "finished", exitCode: 0};
      }
    }
    return {
      async health() {
        update();
        const tool = () => ready.ffmpeg ? {ready: true, version: "simulated"} : {ready: false, reason: "missing"};
        return {ffmpeg: {ready: ready.ffmpeg, tools: {ffmpeg: tool(), ffprobe: tool()}}};
      },
      bridge: Object.freeze({
        shell: "tauri", capabilities: ["getEnvironmentStatus", "installEnvironmentComponent"],
        async getEnvironmentStatus() {
          update();
          return {supported: true, simulation: true, winget: true, webview2: {ready: ready.webview2, version: ready.webview2 ? "simulated" : null}, install: {...install}};
        },
        async installEnvironmentComponent(component) {
          update();
          if (!["ffmpeg", "webview2"].includes(component) || install.phase === "running") throw Error("preview-install-unavailable");
          install = {phase: "running", component, exitCode: null}; finishesAt = now() + 800;
          return {...install};
        }
      })
    };
  }
  const production = root.GivEnvironment;
  root.GivEnvironmentPreview = Object.freeze({simulation});
  root.GivEnvironment = Object.freeze({...production, create(options) {
    const fixture = simulation();
    return production.create({...options, api: (url, ...args) => url === "/api/environment" ? fixture.health() : options.api(url, ...args), bridge: fixture.bridge});
  }});
})(typeof window === "object" ? window : globalThis);
