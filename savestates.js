// savestates.js — Savestate assist UI
//
// Lets you save a checkpoint at any point in a run, and repurposes the
// game's own reset keys (R/Enter and T/Backspace) to bring you back to your
// most recent savestate instead of the start line.
//
// HOW IT WORKS: a savestate doesn't store a position — it stores a snapshot
// of every input you pressed before you saved (up/right/down/left/reset,
// as toggle-frame timestamps, same format the game already uses for its own
// recordings/ghosts) plus the frame count at the moment you saved.
//
// Loading a savestate does a completely normal full reset (the same one a
// genuine restart does — same spawn, same fresh physics car), then drives
// that car through the recorded inputs via the real physics engine, one
// frame at a time, exactly as if it were being played by an invisible
// ghost of you. Because the physics are deterministic and it's driving
// through the *actual* simulation from the *actual* start, velocity,
// drift, suspension state, checkpoint progress, and the timer all fall out
// naturally and correctly — there's no teleport, no reconstruction, no
// fudging. Once the replay reaches your savestate's frame, the car and the
// timer both freeze in place and just sit there until you touch a driving
// key, at which point control hands over to you and you carry on live from
// exactly that point.
//
// Because the run is one continuous, physically-simulated sequence of
// inputs from true frame zero, the car's own recording of "what inputs
// happened on what frame" is just as legitimate as any real run's — this
// is genuinely a rewind, not a practice-only stand-in.
//
// One consequence of driving through the real sim: the replay plays out in
// real time, at the same speed it originally happened (the physics worker
// won't run faster than 1x), so loading a savestate you set 20 seconds in
// takes 20 seconds to catch back up. That's the trade for it being a real
// rewind rather than a teleport.
(function () {
    "use strict";

    const MAX_SAVESTATES = 10;

    /** @type {Array<{frames:number, toggleFrames:{up:number[],right:number[],down:number[],left:number[],reset:number[]}, savedAt:number}>} */
    let savestates = [];

    // The replay currently being driven into the physics engine, if any.
    // { car, recording, targetFrame, done, handedOff, events, timeouts }
    let activeReplay = null;

    window.__ptHasSavestate = () => savestates.length > 0;

    // Merge the five separate toggle-frame arrays (up/right/down/left/reset)
    // into one chronological list of "control state changed" events, each
    // carrying the full resulting control state at that frame. Frames where
    // more than one channel toggled at once collapse into a single event.
    function buildEvents(recording, targetFrame) {
        const frameSet = new Set([0]);
        const raw = recording.getToggleFrames ? recording.getToggleFrames() : null;
        if (raw) {
            for (const key of ["up", "right", "down", "left", "reset"]) {
                for (const f of raw[key]) if (f <= targetFrame) frameSet.add(f);
            }
        }
        return Array.from(frameSet).sort((a, b) => a - b).map((f) => {
            const c = recording.getFrame(f);
            return { frame: f, up: c.up, right: c.right, down: c.down, left: c.left, reset: c.reset, sent: false };
        });
    }

    function clearScheduledTimeouts() {
        if (!activeReplay) return;
        for (const id of activeReplay.timeouts) clearTimeout(id);
        activeReplay.timeouts.length = 0;
    }

    function sendEvent(ev) {
        if (!activeReplay || ev.sent) return;
        ev.sent = true;
        activeReplay.car.setReplayControls(ev.up, ev.right, ev.down, ev.left, ev.reset);
    }

    // The physics worker times every input change off real elapsed
    // wall-clock time (the same way live keyboard input works), not off a
    // frame number we hand it — so the only way to reproduce recorded
    // inputs faithfully is to fire each one at the correct real-world
    // moment ourselves, rather than reacting once per physics-tick batch
    // (which arrives only ~60 times/sec and can blow straight past short
    // taps between batches). This (re)schedules every not-yet-sent event
    // against the most recently confirmed (frame, real time) pair, so it
    // resyncs and self-corrects for drift every time we get fresh ground
    // truth from the physics engine.
    function resyncAndSchedule(knownFrame, knownRealTimeMs) {
        if (!activeReplay) return;
        clearScheduledTimeouts();
        const speed = (window.__ptGetGameSpeed && window.__ptGetGameSpeed()) || 1;
        for (const ev of activeReplay.events) {
            if (ev.sent) continue;
            if (ev.frame <= knownFrame) {
                sendEvent(ev); // overdue relative to ground truth — apply now
                continue;
            }
            const delayMs = Math.max(0, (ev.frame - knownFrame) / speed);
            activeReplay.timeouts.push(setTimeout(() => sendEvent(ev), delayMs));
        }
    }

    // Called from Xa() right after a brand new player car has been fully
    // constructed (on every reset — genuine restart or savestate load).
    window.__ptOnCarCreated = (car) => {
        if (activeReplay) clearScheduledTimeouts();
        activeReplay = null;
        if (savestates.length === 0) { setStatus(null); return; }
        const target = savestates[savestates.length - 1];
        if (!target.frames || target.frames <= 0) { setStatus(null); return; } // saved before ever moving — nothing to replay
        if (typeof window.__ptMakeRecording !== "function") { setStatus(null); return; }
        const recording = window.__ptMakeRecording(target.toggleFrames);
        // Silence the live input source (keyboard/touch) so the player
        // can't interfere with physics while the replay is driving, and
        // kick the car off itself (normally the first up/down press does
        // this, but here we're not going through that path).
        car.isControlsDisabled = true;
        car.start();
        activeReplay = {
            car,
            recording,
            targetFrame: target.frames,
            done: false,
            handedOff: false,
            events: buildEvents(recording, target.frames),
            timeouts: []
        };
        setStatus("Replaying inputs… 0%");
        // Fire frame-0 input(s) immediately rather than waiting for the
        // first physics-tick callback — otherwise a run that accelerates
        // from the very start lags behind its original by however long
        // that first batch takes to arrive.
        resyncAndSchedule(0, performance.now());
    };

    // Called from the patched reset routine (Ja) right before the outgoing
    // car is disposed, whenever any reset happens.
    window.__ptOnBeforeReset = () => {
        if (activeReplay) clearScheduledTimeouts();
        activeReplay = null;
        window.__ptForceFreeze = false;
        setStatus(null);
    };

    // Called once per physics tick batch for the player car (from
    // setCarState). No longer decides what inputs to send — that's handled
    // by the precisely-timed schedule above — this just supplies fresh
    // ground truth to resync against, and detects catching up to the
    // savestate's frame so we can hand off to the player.
    window.__ptOnPlayerCarStateUpdate = (car, state) => {
        if (!activeReplay || activeReplay.car !== car || activeReplay.handedOff || activeReplay.done) return;
        if (state.frames < activeReplay.targetFrame) {
            resyncAndSchedule(state.frames, performance.now());
            const percent = Math.min(99, Math.floor(100 * state.frames / activeReplay.targetFrame));
            setStatus("Replaying inputs… " + percent + "%");
            return;
        }
        // Caught up: freeze the whole simulation (same mechanism the real
        // pause menu uses — player car, ghosts, camera, and audio all stop)
        // without opening the pause menu itself, and wait for the player to
        // take over. Setting car.isPaused directly doesn't stick here: the
        // race loop resyncs it to false every frame regardless, so we drive
        // the loop's own freeze branch instead via this flag.
        activeReplay.done = true;
        clearScheduledTimeouts();
        car.setReplayControls(false, false, false, false, false);
        window.__ptForceFreeze = true;
        setStatus("Caught up — press W or S to continue driving");
        requestAnimationFrame(pollForHandoff);
    };

    // If the player changes the Game Speed slider mid-replay, the real-time
    // schedule needs recomputing against the new speed — otherwise every
    // not-yet-fired event stays timed for the old speed and drifts.
    window.__ptOnSpeedChange = () => {
        if (!activeReplay || activeReplay.handedOff || activeReplay.done) return;
        const state = window.__ptPlayerCarState;
        resyncAndSchedule(state ? state.frames : 0, performance.now());
    };

    // While waiting, poll the live input source at animation-frame rate for
    // the first real driving input (can't rely on physics ticks here since
    // a paused car stops producing them). Any input method — keyboard,
    // touch — funnels through the same shared controls object, so this
    // catches all of them uniformly.
    function pollForHandoff() {
        if (!activeReplay || activeReplay.handedOff || !activeReplay.done) return;
        const controls = window.__ptControls;
        // Only accelerate (W) or brake (S) resume the sim — turning alone
        // (A/D) doesn't count, since it wouldn't actually move the car and
        // players often rest fingers on those keys while lining up a run.
        if (controls && (controls.up || controls.down)) {
            handoff();
            return;
        }
        requestAnimationFrame(pollForHandoff);
    }

    function handoff() {
        if (!activeReplay || activeReplay.handedOff) return;
        activeReplay.handedOff = true;
        clearScheduledTimeouts();
        const car = activeReplay.car;
        // Re-enable the live input source — this also immediately re-sends
        // whatever it's currently reading (including the key that just
        // triggered this) to the physics engine, then unpausing lets the
        // car actually move on it.
        car.isControlsDisabled = false;
        window.__ptForceFreeze = false;
        activeReplay = null;
        setStatus(null);
    }

    // --- Hooks consumed by the patched game code ---

    // Called from ts's constructor whenever a brand new race session starts
    // (new track, or re-entering one), so stale savestates from a previous
    // attempt don't leak into an unrelated run.
    window.__ptOnNewSession = () => {
        if (activeReplay) clearScheduledTimeouts();
        savestates = [];
        activeReplay = null;
        window.__ptForceFreeze = false;
        setStatus(null);
        render();
    };

    // --- Actions ---

    function saveState() {
        const car = window.__ptPlayerCar;
        const cs = window.__ptPlayerCarState;
        if (!car || !cs || typeof car.getRecording !== "function") return;
        const rec = car.getRecording();
        if (!rec || typeof rec.getToggleFrames !== "function") return;
        const frame = cs.frames ?? 0;
        const raw = rec.getToggleFrames();
        const clip = (arr) => arr.filter((f) => f <= frame);
        savestates.push({
            frames: frame,
            toggleFrames: {
                up: clip(raw.up),
                right: clip(raw.right),
                down: clip(raw.down),
                left: clip(raw.left),
                reset: clip(raw.reset)
            },
            savedAt: Date.now()
        });
        if (savestates.length > MAX_SAVESTATES) savestates.shift();
        flash(saveBtn);
        render();
    }

    function deleteLastState() {
        if (savestates.length === 0) return;
        savestates.pop();
        flash(deleteBtn);
        render();
    }

    function loadLastState() {
        if (savestates.length === 0) return;
        // window.__ptTriggerReset() runs the game's own full-reset routine,
        // which (thanks to the patch) will now call __ptOnCarCreated for
        // the fresh car, kicking off the input replay above.
        if (typeof window.__ptTriggerReset === "function") {
            window.__ptTriggerReset();
            flash(loadBtn);
        }
    }

    // --- UI ---

    const container = document.createElement("div");
    container.style.cssText = [
        "position:fixed",
        "right:12px",
        "top:56px",
        "z-index:99999",
        "background:rgba(20,20,25,0.72)",
        "backdrop-filter:blur(4px)",
        "color:#fff",
        "font-family:sans-serif",
        "font-size:12px",
        "padding:8px 10px",
        "border-radius:8px",
        "display:flex",
        "flex-direction:column",
        "align-items:stretch",
        "gap:6px",
        "pointer-events:auto",
        "user-select:none"
    ].join(";");

    const label = document.createElement("span");
    label.style.whiteSpace = "nowrap";

    const statusLabel = document.createElement("span");
    statusLabel.style.cssText = "white-space:nowrap;color:#ffd76a;font-weight:bold;display:none";

    const buttonRow = document.createElement("div");
    buttonRow.style.cssText = "display:flex;gap:6px";

    function makeButton(text) {
        const btn = document.createElement("button");
        btn.textContent = text;
        btn.style.cssText = [
            "flex:1",
            "background:rgba(255,255,255,0.1)",
            "color:#fff",
            "border:1px solid rgba(255,255,255,0.25)",
            "border-radius:5px",
            "padding:4px 6px",
            "font-family:sans-serif",
            "font-size:11px",
            "cursor:pointer",
            "white-space:nowrap"
        ].join(";");
        btn.addEventListener("mouseenter", () => btn.style.background = "rgba(255,255,255,0.22)");
        btn.addEventListener("mouseleave", () => btn.style.background = "rgba(255,255,255,0.1)");
        return btn;
    }

    const saveBtn = makeButton("Save (F6)");
    const loadBtn = makeButton("Load Last (F7)");
    const deleteBtn = makeButton("Delete Last (F9)");

    saveBtn.addEventListener("click", saveState);
    loadBtn.addEventListener("click", loadLastState);
    deleteBtn.addEventListener("click", deleteLastState);

    buttonRow.appendChild(saveBtn);
    buttonRow.appendChild(loadBtn);
    buttonRow.appendChild(deleteBtn);

    container.appendChild(label);
    container.appendChild(statusLabel);
    container.appendChild(buttonRow);

    function setStatus(text) {
        if (text) {
            statusLabel.textContent = text;
            statusLabel.style.display = "block";
        } else {
            statusLabel.style.display = "none";
        }
    }

    function flash(btn) {
        const original = btn.style.background;
        btn.style.background = "rgba(120,220,140,0.5)";
        setTimeout(() => { btn.style.background = original; }, 150);
    }

    function render() {
        label.textContent = "Savestates: " + savestates.length + "/" + MAX_SAVESTATES;
        const hasAny = savestates.length > 0;
        loadBtn.style.opacity = hasAny ? "1" : "0.4";
        loadBtn.style.cursor = hasAny ? "pointer" : "default";
        deleteBtn.style.opacity = hasAny ? "1" : "0.4";
        deleteBtn.style.cursor = hasAny ? "pointer" : "default";
    }

    function mount() {
        document.body.appendChild(container);
        render();
    }
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);

    // Hotkeys: F6 save, F7 load most recent, F9 delete most recent.
    // These aren't used by any of the game's own keybindings.
    window.addEventListener("keydown", (e) => {
        if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
        if (e.code === "F6") { e.preventDefault(); saveState(); }
        else if (e.code === "F7") { e.preventDefault(); loadLastState(); }
        else if (e.code === "F9") { e.preventDefault(); deleteLastState(); }
    });
})();
