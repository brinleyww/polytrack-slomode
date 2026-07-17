// slowmo.js — Game Speed (slow-motion assist) UI
// Scales how much wall-clock time feeds the physics worker's fixed-timestep
// accumulator. The physics step itself (fixed 1ms dt) is never touched —
// this only changes how many real seconds it takes to play out a given
// amount of simulated time, i.e. true slow motion.
(function () {
    "use strict";

    const STORAGE_KEY = "pt_game_speed";
    const MIN_PERCENT = 25;   // slowest allowed: 1/4 real-time speed
    const MAX_PERCENT = 1000; // 10x real-time speed
    const STEP = 5;

    function loadSaved() {
        const raw = localStorage.getItem(STORAGE_KEY);
        const n = raw == null ? 100 : parseInt(raw, 10);
        if (Number.isNaN(n)) return 100;
        return Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, n));
    }

    function save(percent) {
        try {
            localStorage.setItem(STORAGE_KEY, String(percent));
        } catch (e) {}
    }

    let currentPercent = loadSaved();

    function applySpeed(percent) {
        currentPercent = Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, percent));
        save(currentPercent);
        if (window.__ptSimulation && typeof window.__ptSimulation.setSpeed === "function") {
            window.__ptSimulation.setSpeed(currentPercent / 100);
        }
        if (slider) slider.value = String(currentPercent);
        if (textbox && document.activeElement !== textbox) textbox.value = String(currentPercent);
        if (label) label.textContent = "Game Speed:";
        window.__ptOnSpeedChange && window.__ptOnSpeedChange(currentPercent / 100);
    }

    // Lets other scripts (savestates.js) convert simulated frames into
    // real-world milliseconds when scheduling precisely-timed input events.
    window.__ptGetGameSpeed = () => currentPercent / 100;

    // --- UI ---
    const container = document.createElement("div");
    container.style.cssText = [
        "position:fixed",
        "right:12px",
        "top:12px",
        "z-index:99999",
        "background:rgba(20,20,25,0.72)",
        "backdrop-filter:blur(4px)",
        "color:#fff",
        "font-family:sans-serif",
        "font-size:12px",
        "padding:8px 10px",
        "border-radius:8px",
        "display:flex",
        "align-items:center",
        "gap:8px",
        "pointer-events:auto",
        "user-select:none"
    ].join(";");

    const label = document.createElement("span");
    label.style.whiteSpace = "nowrap";
    label.textContent = "Game Speed:";

    const style = document.createElement("style");
    style.textContent = [
        // Chrome/Edge only honor the custom thumb styles below once the
        // input's own native appearance is switched off — otherwise it
        // falls back to the native track+thumb control (which renders as
        // an oversized square box) and layers our thumb CSS on top of it.
        ".pt-speed-slider {",
        "  -webkit-appearance: none;",
        "  appearance: none;",
        "  background: transparent;",
        "  height: 8px;",
        "}",
        // The base game stylesheet has its own global
        // input[type="range"]::-webkit-slider-thumb / ::-moz-range-thumb
        // rules (32px square, thick border) which are MORE specific than a
        // plain ".pt-speed-slider::-webkit-slider-thumb" selector, so they
        // were winning and drawing the big square thumb over our styles.
        // Prefixing with "input" matches that specificity, and !important
        // guarantees it regardless of stylesheet order.
        "input.pt-speed-slider::-webkit-slider-runnable-track {",
        "  height: 4px !important;",
        "  border-radius: 2px !important;",
        "  background: rgba(255,255,255,0.35) !important;",
        "}",
        "input.pt-speed-slider::-moz-range-track {",
        "  height: 4px !important;",
        "  border-radius: 2px !important;",
        "  background: rgba(255,255,255,0.35) !important;",
        "}",
        // Default browser thumb sizes are roughly 16px (Chrome/WebKit) and
        // 12x20px (Firefox) — halved here to ~8px so it doesn't dominate
        // the small speed widget.
        "input.pt-speed-slider::-webkit-slider-thumb {",
        "  -webkit-appearance: none;",
        "  appearance: none;",
        "  width: 8px !important;",
        "  height: 8px !important;",
        "  border-radius: 50% !important;",
        "  background: #fff !important;",
        "  border: none !important;",
        "  outline: none !important;",
        "  cursor: pointer;",
        "  margin-top: -2px !important;", // recenters the 8px thumb on the 4px track above
        "}",
        "input.pt-speed-slider::-moz-range-thumb {",
        "  width: 8px !important;",
        "  height: 8px !important;",
        "  border-radius: 50% !important;",
        "  background: #fff !important;",
        "  border: none !important;",
        "  outline: none !important;",
        "  cursor: pointer;",
        "}"
    ].join("\n");
    document.head.appendChild(style);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "pt-speed-slider";
    slider.min = String(MIN_PERCENT);
    slider.max = String(MAX_PERCENT);
    slider.step = String(STEP);
    slider.value = String(currentPercent);
    slider.style.width = "110px";
    slider.addEventListener("input", () => applySpeed(parseInt(slider.value, 10)));

    const textbox = document.createElement("input");
    textbox.type = "number";
    textbox.min = String(MIN_PERCENT);
    textbox.max = String(MAX_PERCENT);
    textbox.value = String(currentPercent);
    textbox.style.cssText = [
        "width:44px",
        "background:rgba(255,255,255,0.1)",
        "border:1px solid rgba(255,255,255,0.3)",
        "border-radius:4px",
        "color:#fff",
        "font-family:sans-serif",
        "font-size:12px",
        "padding:2px 4px"
    ].join(";");
    function commitTextbox() {
        const n = parseInt(textbox.value, 10);
        if (!Number.isNaN(n)) applySpeed(n);
        else textbox.value = String(currentPercent); // reject garbage input, restore last good value
    }
    textbox.addEventListener("change", commitTextbox);
    textbox.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { commitTextbox(); textbox.blur(); }
    });

    const percentSign = document.createElement("span");
    percentSign.textContent = "%";

    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.textContent = "Reset";
    resetButton.title = "Reset game speed to 100%";
    resetButton.style.cssText = [
        "margin-left:2px",
        "background:rgba(255,255,255,0.1)",
        "border:1px solid rgba(255,255,255,0.3)",
        "border-radius:4px",
        "color:#fff",
        "font-family:sans-serif",
        "font-size:12px",
        "padding:2px 8px",
        "cursor:pointer",
        "pointer-events:auto"
    ].join(";");
    resetButton.addEventListener("mouseenter", () => { resetButton.style.background = "rgba(255,255,255,0.2)"; });
    resetButton.addEventListener("mouseleave", () => { resetButton.style.background = "rgba(255,255,255,0.1)"; });
    resetButton.addEventListener("click", () => applySpeed(100));

    container.appendChild(label);
    container.appendChild(slider);
    container.appendChild(textbox);
    container.appendChild(percentSign);
    container.appendChild(resetButton);

    function mount() {
        document.body.appendChild(container);
    }
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);

    // Hotkeys: [ slower, ] faster, \ reset to 100%
    window.addEventListener("keydown", (e) => {
        if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
        if (e.key === "[") applySpeed(currentPercent - STEP);
        else if (e.key === "]") applySpeed(currentPercent + STEP);
        else if (e.key === "\\") applySpeed(100);
    });

    // The Simulation instance is created asynchronously during game bootstrap,
    // so poll briefly until window.__ptSimulation is available, then apply
    // whatever speed the player had saved from last time.
    const interval = setInterval(() => {
        if (window.__ptSimulation) {
            clearInterval(interval);
            applySpeed(currentPercent);
        }
    }, 200);
})();
