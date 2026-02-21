/* ============================================
   GitHub Merge Queue Simulator
   ============================================ */

// ── Constants ──────────────────────────────────

const PREFIXES = [
    "Fix",
    "Feat",
    "Refactor",
    "Chore",
    "Perf",
    "Test",
    "Docs",
    "Style",
    "CI",
    "Build",
];

const SUBJECTS = [
    "auth flow",
    "user dashboard",
    "rate limiting",
    "DB migrations",
    "search indexing",
    "file uploads",
    "notifications",
    "cache layer",
    "session mgmt",
    "error handling",
    "input validation",
    "logging",
    "webhook delivery",
    "payment flow",
    "email templates",
    "dark mode",
    "accessibility",
    "mobile layout",
    "type safety",
    "test coverage",
    "CI pipeline",
    "Docker config",
    "env variables",
    "SSL renewal",
    "rate limiter",
    "retry logic",
    "queue jobs",
    "data export",
    "user roles",
    "audit log",
    "health checks",
    "metrics endpoint",
    "GraphQL schema",
    "REST API",
    "WebSocket handler",
    "queue worker",
    "image optimize",
    "lazy loading",
    "code splitting",
    "tree shaking",
    "memory leak",
    "race condition",
    "deadlock fix",
    "conn pooling",
    "password hash",
    "token refresh",
    "CORS policy",
    "CSP headers",
    "i18n support",
    "timezone fix",
    "date formatting",
    "currency fmt",
    "pagination",
    "sorting logic",
    "filter engine",
    "search parser",
    "OAuth2 flow",
    "SSO integration",
    "2FA setup",
    "key rotation",
    "S3 uploads",
    "CDN config",
    "DNS records",
    "load balancer",
    "cron jobs",
    "event bus",
    "pub/sub layer",
    "state machine",
];

const PRESETS = {
    "default": {
        successRate: 70,
        buildConcurrency: 10,
        totalCommits: 100,
        ciDuration: 15,
        ciJitter: 10,
        speed: 240,
        label: "Default",
    },
    "mostly-green": {
        successRate: 95,
        buildConcurrency: 10,
        totalCommits: 100,
        ciDuration: 10,
        ciJitter: 5,
        speed: 240,
        label: "Mostly Green",
    },
    "flaky-ci": {
        successRate: 50,
        buildConcurrency: 10,
        totalCommits: 100,
        ciDuration: 15,
        ciJitter: 10,
        speed: 240,
        label: "Flaky CI",
    },
    disaster: {
        successRate: 15,
        buildConcurrency: 10,
        totalCommits: 60,
        ciDuration: 20,
        ciJitter: 10,
        speed: 3600,
        label: "Disaster Mode",
    },
    "fast-and-furious": {
        successRate: 80,
        buildConcurrency: 20,
        totalCommits: 200,
        ciDuration: 5,
        ciJitter: 3,
        speed: 10800,
        label: "Fast & Furious",
    },
};

// ── Configuration ──────────────────────────────

const config = {
    successRate: 70,
    buildConcurrency: 10,
    totalCommits: 100,
    ciDuration: 15, // base CI duration in minutes
    ciJitter: 10, // ± variance around ciDuration in minutes
    speed: 240,
    stepMode: true,
};

// ── State ──────────────────────────────────────

const state = {
    commits: new Map(), // id → commit object
    queue: [], // ordered ids: [0]=oldest (HEAD)
    merged: [], // ids, newest push()ed last
    rejected: [], // ids, newest push()ed last
    totalReruns: 0, // total duplicate CI runs across all commits
    wastedCITime: 0, // CI time lost to restarts + failures (ms)
    successCITime: 0, // CI time spent on successful merges (ms)
    wallClockTime: 0, // total simulated time elapsed (ms)
    sequentialCITime: 0, // sum of all CI durations ever assigned, sequential baseline (ms)
    isRunning: false,
    isPaused: false,
    stepWaiting: false, // true when step mode has paused before evaluation
    animating: false, // true during step-mode transition animation
    previousRun: null, // snapshot of last completed run for comparison
};

// Render bookkeeping (to do incremental DOM updates)
const render = {
    mergedCount: 0, // how many merged cards already in DOM
    rejectedCount: 0, // how many rejected cards already in DOM
    queueDirty: true, // full queue re-render needed
};

let animFrameId = null;
let lastTimestamp = 0;
let chartActiveSeries = "cost";

// ── Commit Generation ──────────────────────────

function commitName(i) {
    const p = PREFIXES[i % PREFIXES.length];
    const s = SUBJECTS[(i * 7 + 3) % SUBJECTS.length];
    return `${p}: ${s}`;
}

function generateCommits(count) {
    const now = Date.now();
    const commits = new Map();
    const queue = [];

    for (let i = 0; i < count; i++) {
        const id = `c-${i}`;
        commits.set(id, {
            id,
            name: commitName(i),
            dateAdded: new Date(now - (count - i) * 12000), // ~12s apart
            ciStatus: "idle", // idle | running | success | fail
            ciDuration: 0, // assigned when CI starts (ms)
            ciElapsed: 0, // ms
            ciOutcome: null, // predetermined: 'success' | 'fail'
            ciRuns: 0, // how many times CI has been started
            firstRunDuration: 0, // duration from the very first CI run, for sequential baseline (ms)
        });
        queue.push(id);
    }
    return { commits, queue };
}

// ── Helpers ────────────────────────────────────

function rand(min, max) {
    return min + Math.random() * (max - min);
}

// Compact time for commit cards (e.g. "4.2m", "12m", "1h 5m")
function formatCardTime(ms) {
    const s = ms / 1000;
    if (s < 60) return s.toFixed(0) + "s";
    const m = s / 60;
    if (m < 60) return m.toFixed(1).replace(/\.0$/, "") + "m";
    const h = Math.floor(m / 60);
    const rem = Math.round(m % 60);
    return rem > 0 ? h + "h " + rem + "m" : h + "h";
}

function formatTime(date) {
    return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

function flashHeader(selector) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.classList.remove("flash");
    // Force reflow to restart animation
    void el.offsetWidth;
    el.classList.add("flash");
}

// ── Simulation Engine ──────────────────────────

function startCI(commit) {
    const baseMs = config.ciDuration * 60000; // minutes → ms
    const jitterMs = config.ciJitter * 60000; // minutes → ms
    const minMs = Math.max(30000, baseMs - jitterMs); // floor at 30s
    const maxMs = baseMs + jitterMs;
    commit.ciStatus = "running";
    commit.ciElapsed = 0;
    commit.ciDuration = rand(minMs, maxMs);
    commit.ciOutcome =
        Math.random() * 100 < config.successRate ? "success" : "fail";
    // Record the first-run duration for the sequential baseline
    // (credited to sequentialCITime only when the commit actually leaves the queue)
    if (commit.ciRuns === 0) {
        commit.firstRunDuration = commit.ciDuration;
    }
    commit.ciRuns++;
    if (commit.ciRuns > 1) {
        state.totalReruns++;
    }
}

// alreadyRemoved = how many items were shifted out of the queue before this call
// (e.g. consecutive successes + the failed commit itself)
function restartActiveWindow(alreadyRemoved) {
    alreadyRemoved = alreadyRemoved || 0;
    // Reconstruct the original queue length (before items were shifted out)
    // so we correctly identify which remaining items were in the active window.
    const originalQueueLen = state.queue.length + alreadyRemoved;
    const originalActiveSize = Math.min(config.buildConcurrency, originalQueueLen);
    const remaining = Math.max(0, originalActiveSize - alreadyRemoved);
    let wasted = 0;
    for (let i = 0; i < remaining; i++) {
        const c = state.commits.get(state.queue[i]);
        // Running commits: their elapsed time is wasted
        if (c.ciStatus === "running" && c.ciElapsed > 0) {
            wasted += c.ciElapsed;
        }
        // Completed commits (success waiting to merge, or another fail behind head):
        // their full CI duration is thrown away
        if (
            (c.ciStatus === "success" || c.ciStatus === "fail") &&
            c.ciDuration > 0
        ) {
            wasted += c.ciDuration;
        }
        c.ciStatus = "idle";
        c.ciElapsed = 0;
        c.ciDuration = 0;
        c.ciOutcome = null;
    }
    state.wastedCITime += wasted;
    return wasted;
}

function update(dt) {
    if (state.queue.length === 0) {
        state.isRunning = false;
        updateButtons();
        updateStats();
        showSummaryButton();
        showSummary();
        return;
    }

    // If step mode is waiting for user or animating, freeze everything
    if (state.stepWaiting || state.animating) return;

    // Track wall clock time
    state.wallClockTime += dt;

    const activeSize = Math.min(config.buildConcurrency, state.queue.length);

    // 1. Start CI for idle active commits
    let anyStarted = false;
    for (let i = 0; i < activeSize; i++) {
        const c = state.commits.get(state.queue[i]);
        if (c.ciStatus === "idle") {
            startCI(c);
            anyStarted = true;
        }
    }
    if (anyStarted) {
        render.queueDirty = true;
    }

    // 2. Advance elapsed time for running CIs
    let anyCompleted = false;
    for (let i = 0; i < activeSize; i++) {
        const c = state.commits.get(state.queue[i]);
        if (c.ciStatus === "running") {
            c.ciElapsed += dt;
            if (c.ciElapsed >= c.ciDuration) {
                c.ciElapsed = c.ciDuration;
                c.ciStatus = c.ciOutcome;
                anyCompleted = true;
            }
        }
    }

    // 3. Re-render queue so finished CIs show green/red immediately
    if (anyCompleted) {
        render.queueDirty = true;
    }

    // 4. Evaluate queue if head is ready (could be newly completed OR left over
    //    from a previous frame, e.g. an item that finished before a failure was processed)
    if (state.queue.length > 0) {
        const head = state.commits.get(state.queue[0]);
        const headReady =
            head && (head.ciStatus === "success" || head.ciStatus === "fail");

        if (headReady) {
            if (config.stepMode) {
                state.stepWaiting = true;
                showStepBanner();
                return;
            }
            evaluateQueue();
        }
    }
}

function evaluateQueue() {
    let moved = false;
    let usefulDelta = 0;
    let wastedDelta = 0;
    let shifted = 0; // track how many items removed from queue head

    while (state.queue.length > 0) {
        const id = state.queue[0];
        const c = state.commits.get(id);

        if (c.ciStatus === "success") {
            state.queue.shift();
            shifted++;
            state.merged.push(id);
            state.successCITime += c.ciDuration;
            state.sequentialCITime += c.firstRunDuration;
            usefulDelta += c.ciDuration;
            moved = true;
            continue;
        }

        if (c.ciStatus === "fail") {
            state.queue.shift();
            shifted++;
            state.rejected.push(id);
            // The failed commit's CI time is useful; it identified a bad commit
            state.successCITime += c.ciDuration;
            state.sequentialCITime += c.firstRunDuration;
            usefulDelta += c.ciDuration;
            moved = true;
            // Restart remaining active window (pass how many were already removed)
            wastedDelta += restartActiveWindow(shifted);
            break; // stop; new CIs will start next frame
        }

        // Still running or idle; can't proceed
        break;
    }

    if (moved) {
        render.queueDirty = true;
        renderMergedIncremental();
        renderRejectedIncremental();
        updateStats();

        // Floating deltas in non-step mode
        if (usefulDelta > 0) {
            showStatDelta("stat-ci-useful", usefulDelta, "var(--green-bright)");
        }
        if (wastedDelta > 0) {
            showStatDelta("stat-ci-wasted", wastedDelta, "var(--red)");
        }

        // Flash lane headers for visual feedback
        if (state.merged.length > render.mergedCount) {
            flashHeader(".lane-header--merged");
        }
        if (state.rejected.length > render.rejectedCount) {
            flashHeader(".lane-header--rejected");
        }
        render.mergedCount = state.merged.length;
        render.rejectedCount = state.rejected.length;
    }
}

// Process only ONE action: all consecutive successes OR a single failure (not both)
// Returns { moved, usefulDelta, wastedDelta } for overlay display
function evaluateQueueStep() {
    let moved = false;
    let usefulDelta = 0;
    let wastedDelta = 0;
    let shifted = 0; // track how many items removed from queue head

    // First: try to merge all consecutive successes from the head
    while (state.queue.length > 0) {
        const c = state.commits.get(state.queue[0]);
        if (c.ciStatus === "success") {
            state.queue.shift();
            shifted++;
            state.merged.push(c.id);
            state.successCITime += c.ciDuration;
            state.sequentialCITime += c.firstRunDuration;
            usefulDelta += c.ciDuration;
            moved = true;
            continue;
        }
        break; // stop at first non-success; don't process a failure here
    }

    // If no successes were processed, try a single failure
    if (!moved && state.queue.length > 0) {
        const c = state.commits.get(state.queue[0]);
        if (c.ciStatus === "fail") {
            state.queue.shift();
            shifted++;
            state.rejected.push(c.id);
            // The failed commit's CI time is useful; it identified a bad commit
            state.successCITime += c.ciDuration;
            state.sequentialCITime += c.firstRunDuration;
            usefulDelta += c.ciDuration;
            moved = true;
            // Wasted time tracked inside restartActiveWindow (pass how many were already removed)
            wastedDelta = restartActiveWindow(shifted);
        }
    }

    if (moved) {
        render.queueDirty = true;
        renderMergedIncremental();
        renderRejectedIncremental();
        updateStats();
        if (state.merged.length > render.mergedCount) {
            flashHeader(".lane-header--merged");
        }
        if (state.rejected.length > render.rejectedCount) {
            flashHeader(".lane-header--rejected");
        }
        render.mergedCount = state.merged.length;
        render.rejectedCount = state.rejected.length;
    }

    return { moved, usefulDelta, wastedDelta };
}

// ── Step Mode ──────────────────────────────────

function previewEvaluation() {
    // Scan the head of the queue to describe what will happen
    if (state.queue.length === 0) return { action: "none" };

    const head = state.commits.get(state.queue[0]);
    if (head.ciStatus === "fail") {
        // Preview wasted time: scan remaining active window (after head is removed)
        // Only check items that were actually in the original active window (minus the head)
        const remaining = state.queue.slice(1);
        const windowSize = Math.max(
            0,
            Math.min(config.buildConcurrency, state.queue.length) - 1,
        );
        let wastedPreview = 0;
        for (let i = 0; i < windowSize; i++) {
            const c = state.commits.get(remaining[i]);
            if (c.ciStatus === "running" && c.ciElapsed > 0) {
                wastedPreview += c.ciElapsed;
            } else if (
                (c.ciStatus === "success" || c.ciStatus === "fail") &&
                c.ciDuration > 0
            ) {
                wastedPreview += c.ciDuration;
            }
        }
        return {
            action: "reject",
            commit: head,
            wastedDelta: wastedPreview,
            description: `Reject "${head.name}". CI failed. Remaining active window will restart CI.`,
        };
    }

    if (head.ciStatus === "success") {
        // Count consecutive successes from head and sum their CI time
        let count = 0;
        let usefulPreview = 0;
        for (let i = 0; i < state.queue.length; i++) {
            const c = state.commits.get(state.queue[i]);
            if (c.ciStatus === "success") {
                count++;
                usefulPreview += c.ciDuration;
            } else {
                break;
            }
        }
        const names = state.queue
            .slice(0, count)
            .map((id) => state.commits.get(id).name);
        const preview =
            count === 1
                ? `Merge "${names[0]}" into main.`
                : `Merge ${count} commits into main: ${names.slice(0, 3).join(", ")}${count > 3 ? ` (+${count - 3} more)` : ""}.`;
        return {
            action: "merge",
            count,
            usefulDelta: usefulPreview,
            description: preview,
        };
    }

    return { action: "none" };
}

function showStepBanner() {
    const icon = document.getElementById("step-banner-icon");
    const title = document.getElementById("step-banner-title");
    const desc = document.getElementById("step-banner-desc");

    const preview = previewEvaluation();

    if (preview.action === "merge") {
        icon.textContent = "✓";
        icon.className = "step-banner-icon step-banner-icon--merge";
        title.textContent =
            preview.count === 1
                ? "Ready to merge 1 commit"
                : `Ready to merge ${preview.count} commits`;
        title.style.color = "var(--green-bright)";
        const timeTag =
            preview.usefulDelta > 0
                ? `  ·  Useful CI: +${formatCITime(preview.usefulDelta)}`
                : "";
        desc.innerHTML =
            preview.description +
            `<span class="step-banner-time step-banner-time--useful">${timeTag}</span>`;
    } else if (preview.action === "reject") {
        icon.textContent = "✕";
        icon.className = "step-banner-icon step-banner-icon--reject";
        title.textContent = "Head commit failed. Reject & restart.";
        title.style.color = "var(--red)";
        const timeTag =
            preview.wastedDelta > 0
                ? `  ·  Wasted CI: +${formatCITime(preview.wastedDelta)}`
                : "";
        desc.innerHTML =
            preview.description +
            `<span class="step-banner-time step-banner-time--wasted">${timeTag}</span>`;
    }

    document.getElementById("step-overlay").hidden = false;
}

function hideStepBanner() {
    document.getElementById("step-overlay").hidden = true;
}

function doStepContinue() {
    if (!state.stepWaiting || state.animating) return;
    hideStepBanner();

    const preview = previewEvaluation();
    if (preview.action === "none") {
        state.stepWaiting = false;
        lastTimestamp = 0;
        return;
    }

    state.animating = true;
    animateStepTransition(preview, () => {
        // Execute only this one action (merges OR reject, not both)
        evaluateQueueStep();

        // Force immediate re-render of queue
        renderQueue();
        render.queueDirty = false;
        // Animate the queue settling into its new positions
        animateQueueReflow(() => {
            state.animating = false;

            // Check if the new head is also ready; if so, pause again (only if step mode still on)
            if (config.stepMode && state.queue.length > 0) {
                const newHead = state.commits.get(state.queue[0]);
                if (
                    newHead &&
                    (newHead.ciStatus === "success" ||
                        newHead.ciStatus === "fail")
                ) {
                    showStepBanner();
                    return; // stepWaiting stays true
                }
            }

            // Nothing more to evaluate right now; resume simulation
            state.stepWaiting = false;
            lastTimestamp = 0;
        });
    });
}

// ── Step Animation ─────────────────────────────

function animateStepTransition(preview, onComplete) {
    const queueBody = document.getElementById("lane-queue");
    const isReject = preview.action === "reject";
    const targetId = isReject ? "lane-rejected" : "lane-merged";
    const targetBody = document.getElementById(targetId);
    const count = isReject ? 1 : preview.count;

    // Make sure the cards being moved are visible
    queueBody.scrollTop = 0;

    // Gather source cards from the queue DOM
    const sourceCards = [];
    for (let i = 0; i < count && i < queueBody.children.length; i++) {
        sourceCards.push(queueBody.children[i]);
    }

    if (sourceCards.length === 0) {
        onComplete();
        return;
    }

    const targetRect = targetBody.getBoundingClientRect();
    const stagger = Math.min(60, 300 / sourceCards.length); // tighter stagger for large groups

    // Create fixed-position clones that will fly to the target lane
    const clones = sourceCards.map((card, i) => {
        const rect = card.getBoundingClientRect();
        const clone = card.cloneNode(true);

        // Strip progress bar from clone for a cleaner flight
        const progress = clone.querySelector(".card-progress");
        if (progress) progress.remove();

        clone.classList.add("card-clone-flying");
        Object.assign(clone.style, {
            position: "fixed",
            top: rect.top + "px",
            left: rect.left + "px",
            width: rect.width + "px",
            height: rect.height + "px",
            zIndex: String(1000 - i),
            margin: "0",
            pointerEvents: "none",
            transition: `top 480ms cubic-bezier(0.16, 1, 0.3, 1) ${i * stagger}ms,
                   left 480ms cubic-bezier(0.16, 1, 0.3, 1) ${i * stagger}ms,
                   width 480ms cubic-bezier(0.16, 1, 0.3, 1) ${i * stagger}ms,
                   height 480ms cubic-bezier(0.16, 1, 0.3, 1) ${i * stagger}ms,
                   opacity 300ms ease ${i * stagger + 200}ms,
                   transform 480ms cubic-bezier(0.16, 1, 0.3, 1) ${i * stagger}ms`,
        });

        document.body.appendChild(clone);

        // Dim + shrink the original in the queue
        Object.assign(card.style, {
            opacity: "0.1",
            transform: "scale(0.95)",
            transition: "opacity 250ms ease, transform 250ms ease",
        });

        return { clone, rect };
    });

    // Trigger the fly on next frame (ensures transition fires)
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            clones.forEach(({ clone }) => {
                Object.assign(clone.style, {
                    top: targetRect.top + 6 + "px",
                    left: targetRect.left + 6 + "px",
                    width: targetRect.width - 12 + "px",
                    opacity: "0",
                    transform: "scale(0.92)",
                });
            });
        });
    });

    // Clean up after the last clone finishes flying
    const totalDuration = 480 + (clones.length - 1) * stagger + 120;
    setTimeout(() => {
        clones.forEach(({ clone }) => clone.remove());
        onComplete();
    }, totalDuration);
}

function animateQueueReflow(onComplete) {
    const queueBody = document.getElementById("lane-queue");
    const limit = Math.min(config.buildConcurrency + 5, queueBody.children.length);

    for (let i = 0; i < limit; i++) {
        const card = queueBody.children[i];
        card.classList.add("card--shifting");
        card.style.animationDelay = `${i * 25}ms`;
    }

    const cleanupTime = 350 + limit * 25 + 50;
    setTimeout(() => {
        queueBody.querySelectorAll(".card--shifting").forEach((c) => {
            c.classList.remove("card--shifting");
            c.style.animationDelay = "";
        });
        if (onComplete) onComplete();
    }, cleanupTime);
}

// ── Game Loop ──────────────────────────────────

function loop(timestamp) {
    if (!state.isRunning) {
        animFrameId = null;
        return;
    }

    if (lastTimestamp === 0) lastTimestamp = timestamp;
    const rawDt = timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    // Apply speed multiplier; cap delta to avoid huge jumps
    const dt = state.isPaused ? 0 : Math.min(rawDt, 200) * config.speed;

    if (!state.isPaused) {
        update(dt);
    }

    // Render
    if (render.queueDirty) {
        renderQueue();
        render.queueDirty = false;
    }
    updateProgressBars();
    updateTimeStats();

    animFrameId = requestAnimationFrame(loop);
}

// ── Controls ───────────────────────────────────

function runInstant() {
    // Run the entire simulation synchronously in one pass
    state.isRunning = true;
    state.isPaused = false;
    updateButtons();
    showSummaryButton();

    // Safety limit to prevent infinite loops
    let iterations = 0;
    const maxIterations = config.totalCommits * config.buildConcurrency * 10;

    while (state.queue.length > 0 && iterations < maxIterations) {
        iterations++;
        const activeSize = Math.min(config.buildConcurrency, state.queue.length);

        // Start CI for idle active commits
        for (let i = 0; i < activeSize; i++) {
            const c = state.commits.get(state.queue[i]);
            if (c.ciStatus === "idle") {
                startCI(c);
            }
        }

        // Find the shortest running CI in the active window (time to next event)
        let minRemaining = Infinity;
        for (let i = 0; i < activeSize; i++) {
            const c = state.commits.get(state.queue[i]);
            if (c.ciStatus === "running") {
                const remaining = c.ciDuration - c.ciElapsed;
                if (remaining < minRemaining) minRemaining = remaining;
            }
        }
        if (minRemaining === Infinity) break; // nothing running

        // Advance all running CIs by that amount
        state.wallClockTime += minRemaining;
        for (let i = 0; i < activeSize; i++) {
            const c = state.commits.get(state.queue[i]);
            if (c.ciStatus === "running") {
                c.ciElapsed += minRemaining;
                if (c.ciElapsed >= c.ciDuration) {
                    c.ciElapsed = c.ciDuration;
                    c.ciStatus = c.ciOutcome;
                }
            }
        }

        // Evaluate the queue (merge successes, handle failure)
        evaluateQueue();
    }

    // Finalize
    state.isRunning = false;
    render.queueDirty = true;
    renderQueue();
    renderMergedIncremental();
    renderRejectedIncremental();
    updateStats();
    updateButtons();
    updateTimeStats();
    showSummaryButton();
    showSummary();
}

function doStart() {
    if (state.isRunning && !state.isPaused) return;

    if (state.isPaused) {
        state.isPaused = false;
        lastTimestamp = 0; // reset to avoid time jump
        updateButtons();
        return;
    }

    state.isRunning = true;
    state.isPaused = false;
    lastTimestamp = 0;
    updateButtons();
    showSummaryButton();

    animFrameId = requestAnimationFrame(loop);
}

function doPause() {
    if (!state.isRunning || state.isPaused) return;
    state.isPaused = true;
    updateButtons();
}

function toggleRun() {
    if (state.isRunning && !state.isPaused) {
        doPause();
    } else {
        doStart();
    }
}

function doReset() {
    state.isRunning = false;
    state.isPaused = false;
    state.stepWaiting = false;
    state.animating = false;
    hideStepBanner();
    hideSummary();
    hideSummaryButton();
    // Clean up any in-flight animation clones
    document
        .querySelectorAll(".card-clone-flying")
        .forEach((el) => el.remove());
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    lastTimestamp = 0;

    // Snapshot current run for comparison (only if something actually ran)
    if (state.merged.length > 0 || state.rejected.length > 0) {
        const rate = getCostRate();
        const runners = getCostRunners();
        const toMin = 1 / 60000;
        const costPerMin = rate * runners;
        state.previousRun = {
            merged: state.merged.length,
            rejected: state.rejected.length,
            processed: state.merged.length + state.rejected.length,
            buildConcurrency: config.buildConcurrency,
            reruns: state.totalReruns,
            wallClockTime: state.wallClockTime,
            sequentialCITime: state.sequentialCITime,
            successCITime: state.successCITime,
            wastedCITime: state.wastedCITime,
            totalCost:
                (state.successCITime + state.wastedCITime) * toMin * costPerMin,
            wastedCost: state.wastedCITime * toMin * costPerMin,
        };
    }

    const { commits, queue } = generateCommits(config.totalCommits);
    state.commits = commits;
    state.queue = queue;
    state.merged = [];
    state.rejected = [];
    state.totalReruns = 0;
    state.wastedCITime = 0;
    state.successCITime = 0;
    state.wallClockTime = 0;
    state.sequentialCITime = 0;

    // Reset render bookkeeping
    render.mergedCount = 0;
    render.rejectedCount = 0;
    render.queueDirty = true;

    // Clear lane DOMs
    document.getElementById("lane-merged").innerHTML = "";
    document.getElementById("lane-rejected").innerHTML = "";

    renderQueue();
    updateStats();
    updateButtons();
}

function updateButtons() {
    const startBtn = document.getElementById("btn-start");
    const sumStartBtn = document.getElementById("summary-start");

    function setButton(btn, icon, label, disabled, isPause) {
        if (!btn) return;
        const iconEl = btn.querySelector(".btn-icon");
        if (iconEl) iconEl.textContent = icon;
        const labelEl = btn.querySelector(".btn-start-label");
        if (labelEl) labelEl.textContent = label;
        btn.disabled = disabled;
        btn.classList.toggle("btn--paused", !!isPause);
    }

    if (state.isRunning && !state.isPaused) {
        setButton(startBtn, "⏸", "Pause", false, true);
        setButton(sumStartBtn, "⏸", "Pause", false, true);
    } else if (state.isRunning && state.isPaused) {
        setButton(startBtn, "▶", "Resume", false, false);
        setButton(sumStartBtn, "▶", "Resume", false, false);
    } else {
        setButton(startBtn, "▶", "Start", state.queue.length === 0, false);
        setButton(sumStartBtn, "▶", "Start", state.queue.length === 0, false);
    }
}

// ── Rendering: Queue ───────────────────────────

function renderQueue() {
    const container = document.getElementById("lane-queue");
    const activeSize = Math.min(config.buildConcurrency, state.queue.length);

    // Build all cards as HTML string (fast for bulk rendering)
    const fragments = [];
    for (let i = 0; i < state.queue.length; i++) {
        const id = state.queue[i];
        const c = state.commits.get(id);
        const isActive = i < activeSize;
        fragments.push(buildQueueCard(c, isActive));
    }
    container.innerHTML = fragments.join("");

    document.getElementById("count-queue").textContent = state.queue.length;
}

function buildQueueCard(commit, isActive) {
    const runsTag =
        commit.ciRuns > 1
            ? `<span class="card-reruns-badge" title="This commit had to rerun CI ${commit.ciRuns - 1} time(s) because earlier commits in the queue failed.">Restarted ${commit.ciRuns - 1}×</span>`
            : "";

    if (!isActive) {
        return `<div class="card card--inactive" data-id="${commit.id}">
      <div class="card-row">
        <span class="card-dot"></span>
        <span class="card-name">${commit.name}</span>
        ${runsTag}
      </div>
    </div>`;
    }

    const statusClass = `card--${commit.ciStatus}`;
    const pct =
        commit.ciDuration > 0
            ? Math.min(100, (commit.ciElapsed / commit.ciDuration) * 100)
            : 0;

    let badge = "";
    let timeStr = "";

    if (commit.ciStatus === "running") {
        timeStr = `<span class="card-time">${formatCardTime(commit.ciElapsed)}/${formatCardTime(commit.ciDuration)}</span>`;
    } else if (commit.ciStatus === "success") {
        badge = '<span class="card-badge">✓</span>';
        timeStr = `<span class="card-time">${formatCardTime(commit.ciDuration)}</span>`;
    } else if (commit.ciStatus === "fail") {
        badge = '<span class="card-badge">✕</span>';
        timeStr = `<span class="card-time">${formatCardTime(commit.ciDuration)}</span>`;
    }

    // Progress bar always visible; fill class varies by status
    const fillClass =
        commit.ciStatus === "success"
            ? "card-progress-fill card-progress-fill--success"
            : commit.ciStatus === "fail"
              ? "card-progress-fill card-progress-fill--fail"
              : "card-progress-fill";
    const fillPct =
        commit.ciStatus === "success" || commit.ciStatus === "fail" ? 100 : pct;

    return `<div class="card ${statusClass}" data-id="${commit.id}">
    <div class="card-row">
      <span class="card-dot"></span>
      <span class="card-name">${commit.name}</span>
      ${runsTag}${badge}${timeStr}
    </div>
    <div class="card-progress"><div class="${fillClass}" style="width:${fillPct}%"></div></div>
  </div>`;
}

// ── Rendering: Merged / Rejected (incremental) ─

function renderMergedIncremental() {
    const container = document.getElementById("lane-merged");
    for (let i = render.mergedCount; i < state.merged.length; i++) {
        const c = state.commits.get(state.merged[i]);
        const runsTag =
            c.ciRuns > 1
                ? `<span class="card-reruns-badge" title="This commit had to rerun CI ${c.ciRuns - 1} time(s) because earlier commits in the queue failed.">Restarted ${c.ciRuns - 1}×</span>`
                : "";
        const card = document.createElement("div");
        card.className = "card card--merged card--entering";
        card.dataset.id = c.id;
        card.innerHTML = `
      <div class="card-row">
        <span class="card-dot"></span>
        <span class="card-name">${c.name}</span>
        ${runsTag}
        <span class="card-date">${formatTime(c.dateAdded)}</span>
      </div>`;
        // Prepend so newest is at top
        container.prepend(card);
    }
    document.getElementById("count-merged").textContent = state.merged.length;
}

function renderRejectedIncremental() {
    const container = document.getElementById("lane-rejected");
    for (let i = render.rejectedCount; i < state.rejected.length; i++) {
        const c = state.commits.get(state.rejected[i]);
        const runsTag =
            c.ciRuns > 1
                ? `<span class="card-reruns-badge" title="This commit had to rerun CI ${c.ciRuns - 1} time(s) because earlier commits in the queue failed.">Restarted ${c.ciRuns - 1}×</span>`
                : "";
        const card = document.createElement("div");
        card.className = "card card--rejected card--entering";
        card.dataset.id = c.id;
        card.innerHTML = `
      <div class="card-row">
        <span class="card-dot"></span>
        <span class="card-name">${c.name}</span>
        ${runsTag}
        <span class="card-date">${formatTime(c.dateAdded)}</span>
      </div>`;
        container.prepend(card);
    }
    document.getElementById("count-rejected").textContent =
        state.rejected.length;
}

// ── Rendering: Progress Bars ───────────────────

function updateProgressBars() {
    const container = document.getElementById("lane-queue");
    const activeSize = Math.min(config.buildConcurrency, state.queue.length);

    for (let i = 0; i < activeSize; i++) {
        const c = state.commits.get(state.queue[i]);
        if (c.ciStatus !== "running") continue;

        const card = container.children[i];
        if (!card) continue;

        const fill = card.querySelector(".card-progress-fill");
        if (fill) {
            const pct = Math.min(100, (c.ciElapsed / c.ciDuration) * 100);
            fill.style.width = pct + "%";
        }

        const timeEl = card.querySelector(".card-time");
        if (timeEl) {
            timeEl.textContent = `${formatCardTime(c.ciElapsed)}/${formatCardTime(c.ciDuration)}`;
        }
    }
}

// ── Rendering: Stat Deltas (floating overlays) ─

function showStatDelta(statId, deltaMs, color) {
    if (deltaMs <= 0) return;
    const anchor = document.getElementById(statId);
    if (!anchor) return;

    const el = document.createElement("span");
    el.className = "stat-delta";
    el.textContent = "+" + formatCITime(deltaMs);
    el.style.color = color;

    // Position relative to the stat value
    anchor.style.position = "relative";
    anchor.appendChild(el);

    // Trigger animation on next frame
    requestAnimationFrame(() => {
        el.classList.add("stat-delta--active");
    });

    // Remove after animation
    setTimeout(() => el.remove(), 1200);
}

// ── Rendering: Stats ───────────────────────────

function formatCITime(ms) {
    const sign = ms < 0 ? "-" : "";
    const abs = Math.abs(ms);
    const s = abs / 1000;
    if (s < 60) return sign + s.toFixed(1) + " s";
    const totalMin = s / 60;
    if (totalMin < 60) {
        const m = Math.floor(totalMin);
        const rem = Math.round(s % 60);
        return sign + (rem > 0 ? m + "m " + rem + "s" : m + " m");
    }
    const h = Math.floor(totalMin / 60);
    const remMin = Math.round(totalMin % 60);
    return sign + (remMin > 0 ? h + "h " + remMin + "m" : h + " h");
}

function updateTimeStats() {
    document.getElementById("stat-wall-clock").textContent = formatCITime(
        state.wallClockTime,
    );
    const saved = state.sequentialCITime - state.wallClockTime;
    document.getElementById("stat-time-saved").textContent =
        saved > 0 ? formatCITime(saved) : "0 s";
    updateSummaryPanel();
}

function updateStats() {
    document.getElementById("stat-queue").textContent = state.queue.length;
    document.getElementById("stat-merged").textContent = state.merged.length;
    document.getElementById("stat-rejected").textContent =
        state.rejected.length;
    document.getElementById("stat-reruns").textContent = state.totalReruns;
    document.getElementById("count-queue").textContent = state.queue.length;
    document.getElementById("count-merged").textContent = state.merged.length;
    document.getElementById("count-rejected").textContent =
        state.rejected.length;

    // CI time stats
    document.getElementById("stat-ci-useful").textContent = formatCITime(
        state.successCITime,
    );
    document.getElementById("stat-ci-wasted").textContent = formatCITime(
        state.wastedCITime,
    );

    const ratioEl = document.getElementById("stat-ci-ratio");
    if (state.successCITime > 0) {
        const pct = Math.round(
            (state.wastedCITime / state.successCITime) * 100,
        );
        ratioEl.textContent = pct + "%";
    } else if (state.wastedCITime > 0) {
        ratioEl.textContent = "∞";
    } else {
        ratioEl.textContent = "-";
    }

    // Wall clock & time saved
    updateTimeStats();

    // Percentages for merged vs rejected
    const settled = state.merged.length + state.rejected.length;
    const pctMerged = document.getElementById("pct-merged");
    const pctRejected = document.getElementById("pct-rejected");
    if (settled > 0) {
        pctMerged.textContent =
            Math.round((state.merged.length / settled) * 100) + "%";
        pctRejected.textContent =
            Math.round((state.rejected.length / settled) * 100) + "%";
    } else {
        pctMerged.textContent = "";
        pctRejected.textContent = "";
    }
}

// ── Summary Overlay ────────────────────────────

function showSummaryButton() {}
function hideSummaryButton() {}

function updateSummaryPanel() {
    const overlay = document.getElementById("summary-overlay");
    if (!overlay || overlay.hidden) return;

    const total = state.merged.length + state.rejected.length;
    const successRate =
        total > 0 ? Math.round((state.merged.length / total) * 100) : 0;
    const wasteRatio =
        state.successCITime > 0
            ? Math.round((state.wastedCITime / state.successCITime) * 100)
            : state.wastedCITime > 0
              ? Infinity
              : 0;
    const timeSaved = state.sequentialCITime - state.wallClockTime;

    // Hero stats (top grid)
    document.getElementById("sum-hero-wall-clock").textContent = formatCITime(
        state.wallClockTime,
    );
    document.getElementById("sum-hero-time-saved").textContent =
        timeSaved > 0 ? formatCITime(timeSaved) : "0 s";
    document.getElementById("sum-hero-waste-ratio").textContent =
        wasteRatio === Infinity ? "∞" : wasteRatio ? wasteRatio + "%" : "-";
    document.getElementById("sum-hero-wasted-ci").textContent = formatCITime(
        state.wastedCITime,
    );

    // Queue stats rows
    document.getElementById("sum-build-concurrency").textContent = config.buildConcurrency;
    document.getElementById("sum-processed").textContent = total;
    document.getElementById("sum-merged-cmp").textContent = state.merged.length;
    document.getElementById("sum-rejected-cmp").textContent =
        state.rejected.length;

    // Time rows
    document.getElementById("sum-wall-clock").textContent = formatCITime(
        state.wallClockTime,
    );
    document.getElementById("sum-sequential").textContent = formatCITime(
        state.sequentialCITime,
    );
    document.getElementById("sum-time-saved").textContent =
        timeSaved > 0 ? formatCITime(timeSaved) : "0 s";

    // CI rows
    document.getElementById("sum-useful-ci").textContent = formatCITime(
        state.successCITime,
    );
    document.getElementById("sum-wasted-ci").textContent = formatCITime(
        state.wastedCITime,
    );
    document.getElementById("sum-waste-ratio").textContent =
        wasteRatio === Infinity ? "∞" : wasteRatio ? wasteRatio + "%" : "-";

    // Cost rows
    const rate = getCostRate();
    const runners = getCostRunners();
    const toMin = 1 / 60000;
    const costPerMin = rate * runners;
    const totalCIMin = (state.successCITime + state.wastedCITime) * toMin;
    const wastedCIMin = state.wastedCITime * toMin;
    const totalCost = totalCIMin * costPerMin;
    const wastedCost = wastedCIMin * costPerMin;
    // Summary cost computed fields
    const machineMin = config.ciDuration * runners;
    const sumMachine = document.getElementById("sum-cost-machine-time");
    const sumPerRun = document.getElementById("sum-cost-per-run");
    if (sumMachine) {
        sumMachine.textContent =
            machineMin >= 60
                ? (machineMin / 60).toFixed(1).replace(/\.0$/, "") + " h"
                : machineMin + " min";
    }
    if (sumPerRun) sumPerRun.textContent = formatCost(machineMin * rate);

    document.getElementById("sum-total-cost").textContent =
        formatCost(totalCost);
    document.getElementById("sum-wasted-cost").textContent =
        formatCost(wastedCost);

    // Comparison with previous run
    const prev = state.previousRun;
    const hasCompare = !!prev;
    const colHeader = document.getElementById("summary-col-header");
    if (colHeader) colHeader.hidden = !hasCompare;

    // Toggle compare grid layout on all summary rows
    document.querySelectorAll(".summary-row").forEach((row) => {
        row.classList.toggle("summary-row--compare", hasCompare);
    });

    // Helper: set prev value, diff value, and diff color
    // lowerIsBetter: true for costs/waste/time, false for time saved/useful
    function setCompare(id, currentVal, prevVal, formatter, lowerIsBetter) {
        const prevEl = document.getElementById(id + "-prev");
        const diffEl = document.getElementById(id + "-diff");
        if (!prevEl || !diffEl) return;
        if (!hasCompare) {
            prevEl.textContent = "";
            diffEl.textContent = "";
            diffEl.className = "summary-row-diff";
            return;
        }
        prevEl.textContent = formatter(prevVal);
        const delta = currentVal - prevVal;
        if (Math.abs(delta) < 0.001) {
            diffEl.textContent = "=";
            diffEl.className = "summary-row-diff";
        } else {
            const sign = delta > 0 ? "+" : "";
            diffEl.textContent = sign + formatter(delta);
            const isBetter = lowerIsBetter ? delta < 0 : delta > 0;
            diffEl.className =
                "summary-row-diff " +
                (isBetter
                    ? "summary-row-diff--better"
                    : "summary-row-diff--worse");
        }
    }

    const fmtInt = (v) => String(v);

    if (prev) {
        const prevTimeSaved = prev.sequentialCITime - prev.wallClockTime;
        const prevWasteRatio =
            prev.successCITime > 0
                ? Math.round((prev.wastedCITime / prev.successCITime) * 100)
                : 0;

        // Queue stats
        setCompare(
            "sum-build-concurrency",
            config.buildConcurrency,
            prev.buildConcurrency,
            fmtInt,
            false,
        );
        setCompare("sum-processed", total, prev.processed, fmtInt, false);
        setCompare(
            "sum-merged-cmp",
            state.merged.length,
            prev.merged,
            fmtInt,
            false,
        );
        setCompare(
            "sum-rejected-cmp",
            state.rejected.length,
            prev.rejected,
            fmtInt,
            true,
        );

        // Time
        setCompare(
            "sum-wall-clock",
            state.wallClockTime,
            prev.wallClockTime,
            formatCITime,
            true,
        );
        setCompare(
            "sum-sequential",
            state.sequentialCITime,
            prev.sequentialCITime,
            formatCITime,
            true,
        );
        setCompare(
            "sum-time-saved",
            Math.max(0, timeSaved),
            Math.max(0, prevTimeSaved),
            formatCITime,
            false,
        );
        setCompare(
            "sum-useful-ci",
            state.successCITime,
            prev.successCITime,
            formatCITime,
            false,
        );
        setCompare(
            "sum-wasted-ci",
            state.wastedCITime,
            prev.wastedCITime,
            formatCITime,
            true,
        );
        setCompare(
            "sum-waste-ratio",
            wasteRatio === Infinity ? 999 : wasteRatio,
            prevWasteRatio,
            (v) => v + "%",
            true,
        );
        setCompare(
            "sum-total-cost",
            totalCost,
            prev.totalCost,
            formatCost,
            true,
        );
        setCompare(
            "sum-wasted-cost",
            wastedCost,
            prev.wastedCost,
            formatCost,
            true,
        );
    } else {
        // Clear all prev/diff fields
        [
            "sum-build-concurrency",
            "sum-processed",
            "sum-merged-cmp",
            "sum-rejected-cmp",
            "sum-wall-clock",
            "sum-sequential",
            "sum-time-saved",
            "sum-useful-ci",
            "sum-wasted-ci",
            "sum-waste-ratio",
            "sum-total-cost",
            "sum-wasted-cost",
        ].forEach((id) => {
            setCompare(id, 0, 0, () => "", true);
        });
    }
}

function showSummary() {
    const overlay = document.getElementById("summary-overlay");
    if (!overlay) return;
    const title = document.getElementById("summary-title");
    if (title) {
        title.textContent =
            state.queue.length === 0
                ? "Simulation Complete"
                : "Simulation Summary";
    }
    // If already open (instant re-run), just update without toggling hidden
    if (!overlay.hidden) {
        updateSummaryPanel();
        return;
    }
    overlay.hidden = false;
    updateSummaryPanel();
}

function hideSummary() {
    if (state._keepSummaryOpen) return;
    const overlay = document.getElementById("summary-overlay");
    if (overlay) overlay.hidden = true;
}

function initSummary() {
    const closeBtn = document.getElementById("summary-close");
    const resetBtn = document.getElementById("summary-reset");
    const startBtn = document.getElementById("summary-start");
    const overlay = document.getElementById("summary-overlay");
    const openBtn = document.getElementById("btn-summary");

    const instantBtn = document.getElementById("summary-instant");

    if (closeBtn) closeBtn.addEventListener("click", hideSummary);
    if (startBtn) startBtn.addEventListener("click", toggleRun);
    if (resetBtn)
        resetBtn.addEventListener("click", () => {
            state._keepSummaryOpen = true;
            doReset();
            state._keepSummaryOpen = false;
            updateSummaryPanel();
        });
    if (instantBtn)
        instantBtn.addEventListener("click", () => {
            // Keep overlay open and suppress animations for in-place re-run
            state._keepSummaryOpen = true;
            doReset();
            runInstant();
            state._keepSummaryOpen = false;
        });
    if (openBtn) openBtn.addEventListener("click", showSummary);
    const summarySidebar = document.getElementById("btn-summary-sidebar");
    if (summarySidebar) {
        summarySidebar.addEventListener("click", () => {
            showSummary();
            closeSidebar();
        });
    }
    // Close on backdrop click
    if (overlay)
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) hideSummary();
        });

    // Update summary when cost inputs change
    const sumRate = document.getElementById("sum-cost-rate");
    const sumRunners = document.getElementById("sum-cost-runners");
    if (sumRate)
        sumRate.addEventListener("input", () => {
            updateSummaryPanel();
            updateChartEstimate();
        });
    if (sumRunners)
        sumRunners.addEventListener("input", () => {
            updateSummaryPanel();
            updateChartEstimate();
        });
}

// ── Cost Helpers ────────────────────────────────

function formatCost(dollars) {
    if (dollars < 0.01 && dollars > 0) return "< $0.01";
    if (dollars >= 1000)
        return "$" + dollars.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (dollars >= 100) return "$" + dollars.toFixed(0);
    if (dollars >= 10) return "$" + dollars.toFixed(1);
    return "$" + dollars.toFixed(2);
}

function getCostRate() {
    const input = document.getElementById("sum-cost-rate");
    if (!input) return 0;
    const val = parseFloat(input.value);
    return isNaN(val) || val < 0 ? 0 : val;
}

function getCostRunners() {
    const input = document.getElementById("sum-cost-runners");
    if (!input) return 1;
    const val = parseInt(input.value, 10);
    return isNaN(val) || val < 1 ? 1 : val;
}

// ── Sidebar Bindings ───────────────────────────

function readConfigFromUI() {
    config.successRate = parseFloat(document.getElementById("cfg-success-rate").value);
    config.buildConcurrency = +document.getElementById("cfg-build-concurrency").value;
    config.totalCommits = +document.getElementById("cfg-total-commits").value;
    config.ciDuration = +document.getElementById("cfg-ci-duration").value;
    config.ciJitter = +document.getElementById("cfg-ci-jitter").value;
    saveConfig();
    updatePresetButtonStates();
}

const CONFIG_STORAGE_KEY = "ghmq-config";

function saveConfig() {
    try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({
            successRate: config.successRate,
            buildConcurrency: config.buildConcurrency,
            totalCommits: config.totalCommits,
            ciDuration: config.ciDuration,
            ciJitter: config.ciJitter,
            speed: config.speed,
            stepMode: config.stepMode,
        }));
    } catch (_) {}
}

function loadConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY));
        if (!saved) return;
        if (saved.successRate != null) config.successRate = saved.successRate;
        if (saved.buildConcurrency != null) config.buildConcurrency = saved.buildConcurrency;
        if (saved.totalCommits != null) config.totalCommits = saved.totalCommits;
        if (saved.ciDuration != null) config.ciDuration = saved.ciDuration;
        if (saved.ciJitter != null) config.ciJitter = saved.ciJitter;
        if (saved.speed != null) config.speed = saved.speed;
        if (saved.stepMode != null) config.stepMode = saved.stepMode;
    } catch (_) {}
}

function getOptimalConcurrency() {
    const p = config.successRate / 100;
    if (p >= 1) return 50; // 100% success → max parallelism
    if (p <= 0) return 1; // 0% success → no point in parallel runs
    return Math.max(1, Math.min(50, Math.round(1 / (1 - p))));
}

// ── Optimal Chart ──────────────────────────────

function computeEstimateAtConcurrency(b) {
    const p = config.successRate / 100;
    const pb = Math.pow(p, b);
    let em = 0;
    for (let k = 0; k < b; k++) em += k * Math.pow(p, k) * (1 - p);
    em += b * pb;
    const removed = em + (1 - pb);
    const cycles = removed > 0.0001 ? config.totalCommits / removed : 9999;
    const wallMin = cycles * config.ciDuration;
    const totalRuns = Math.max(1, cycles - 0.5) * b;
    const runners = getCostRunners();
    const rate = getCostRate();
    const totalCost = totalRuns * config.ciDuration * runners * rate;
    let wallStr;
    if (wallMin < 60) wallStr = "~" + Math.round(wallMin) + " min";
    else if (wallMin < 1440) wallStr = "~" + (wallMin / 60).toFixed(1) + " hrs";
    else wallStr = "~" + (wallMin / 1440).toFixed(1) + " days";
    const costStr =
        totalCost >= 1
            ? "~$" + Math.round(totalCost)
            : "~$" + totalCost.toFixed(2);
    const multiplier = Math.max(1, totalRuns / config.totalCommits);
    const multStr = multiplier < 10 ? multiplier.toFixed(1) : Math.round(multiplier).toString();
    return { wallStr, costStr, multStr };
}

function updateChartEstimate() {
    const wallEl = document.getElementById("est-wall-clock");
    const costEl = document.getElementById("est-cost");
    const wallOptEl = document.getElementById("est-wall-clock-at-optimal");
    const costOptEl = document.getElementById("est-cost-at-optimal");
    if (!wallEl || !costEl) return;

    const current = computeEstimateAtConcurrency(config.buildConcurrency);
    const optimal = computeEstimateAtConcurrency(getOptimalConcurrency());

    wallEl.textContent = current.wallStr;
    costEl.textContent = current.costStr + " (" + current.multStr + "x)";

    if (wallOptEl) wallOptEl.textContent = optimal.wallStr;
    if (costOptEl) costOptEl.textContent = optimal.costStr + " (" + optimal.multStr + "x)";
}

function renderOptimalChart() {
    const canvas = document.getElementById("optimal-chart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // Handle high-DPI displays
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = { top: 8, right: 8, bottom: 38, left: 44 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const p = config.successRate / 100;
    const maxConcurrency = 50;

    // Compute data series
    const cost = [];
    const wallClock = [];
    for (let b = 1; b <= maxConcurrency; b++) {
        const pb = Math.pow(p, b);

        // E[merged] = sum_{k=0}^{b-1} k * p^k * (1-p)  +  b * p^b
        let em = 0;
        for (let k = 0; k < b; k++) em += k * Math.pow(p, k) * (1 - p);
        em += b * pb;

        // Items removed per cycle = merged + rejected
        const removed = em + (1 - pb);
        const cycles = removed > 0.0001 ? config.totalCommits / removed : 9999;

        // Cost multiplier: total CI runs / totalCommits (vs sequential = 1x)
        const totalRuns = Math.max(1, cycles - 0.5) * b;
        cost.push(Math.max(1, totalRuns / config.totalCommits));

        // Wall clock: cycles * ciDuration (lower = better)
        wallClock.push(cycles * config.ciDuration);
    }

    // Scale cost from 1x (bottom) to max (top)
    const minC = 1;
    const maxC = Math.max(...cost, minC + 0.001);
    const normC = cost.map((v) => (v - minC) / (maxC - minC));
    // Wall clock: sqrt scale, between linear and log for a balanced view
    const maxW = Math.max(...wallClock, 0.001);
    const sqrtMax = Math.sqrt(maxW);
    const normW = wallClock.map((v) => Math.sqrt(v) / sqrtMax);

    // Read CSS colors
    const styles = getComputedStyle(document.documentElement);
    const colBlue = styles.getPropertyValue("--blue").trim() || "#388bfd";
    const colRed = styles.getPropertyValue("--red").trim() || "#f85149";
    const colBorder = styles.getPropertyValue("--border").trim() || "#30363d";
    const colMuted =
        styles.getPropertyValue("--text-muted").trim() || "#484f58";
    const colBg = styles.getPropertyValue("--bg-card").trim() || "#1c2128";
    const colText =
        styles.getPropertyValue("--text-primary").trim() || "#e6edf3";
    const colPurple = styles.getPropertyValue("--purple").trim() || "#a371f7";
    const colCurrentLine =
        styles.getPropertyValue("--chart-current-line").trim() || colMuted;

    // Clear and fill background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colBg;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 6);
    ctx.fill();

    // X and Y axis lines
    ctx.strokeStyle = colBorder;
    ctx.lineWidth = 1;
    // Y-axis
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.stroke();
    // X-axis
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();

    // Subtle grid lines
    ctx.strokeStyle = colBorder;
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++) {
        const y = pad.top + plotH * (i / 4);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
    }

    // Y-axis tick labels for cost and wall clock series
    if (chartActiveSeries === "cost" || chartActiveSeries === "wall") {
        let seriesColor, formatVal;
        if (chartActiveSeries === "cost") {
            seriesColor = colRed;
            formatVal = (v) => (v < 10 ? v.toFixed(1) : Math.round(v).toString()) + "x";
        } else {
            seriesColor = colPurple;
            formatVal = (v) => {
                if (v < 60) return Math.round(v) + "m";
                if (v < 1440) return (v / 60).toFixed(1) + "h";
                return (v / 1440).toFixed(1) + "d";
            };
        }

        ctx.fillStyle = seriesColor;
        ctx.font = "11px " + (styles.getPropertyValue("--font-mono").trim() || "monospace");
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";

        for (let i = 0; i <= 4; i++) {
            const normVal = i / 4;
            const y = pad.top + plotH * (1 - normVal);
            let actual;
            if (chartActiveSeries === "wall") {
                actual = (normVal * sqrtMax) * (normVal * sqrtMax);
            } else {
                actual = minC + normVal * (maxC - minC);
            }
            ctx.fillText(formatVal(actual), pad.left - 4, y);
        }
    }

    // Helper: concurrency value to x
    function bx(b) {
        return pad.left + ((b - 1) / (maxConcurrency - 1)) * plotW;
    }
    // Helper: normalized value to y (0 = bottom, 1 = top)
    function by(v) {
        return pad.top + plotH * (1 - v);
    }

    // Draw a line series
    function drawLine(data, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
            const x = bx(i + 1);
            const y = by(data[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Draw cost line (red)
    drawLine(normC, colRed);

    // Draw wall clock line (purple)
    drawLine(normW, colPurple);

    // Current build concurrency vertical dashed line + dots
    const current = config.buildConcurrency;
    const curX = bx(current);
    ctx.strokeStyle = colCurrentLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(curX, pad.top);
    ctx.lineTo(curX, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dot on cost line at current concurrency
    const curCY = by(normC[current - 1] || 0);
    ctx.fillStyle = colRed;
    ctx.beginPath();
    ctx.arc(curX, curCY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Dot on wall clock line at current concurrency
    const curWY = by(normW[current - 1] || 0);
    ctx.fillStyle = colPurple;
    ctx.beginPath();
    ctx.arc(curX, curWY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // X-axis tick marks and labels
    const xTicks = [1, 10, 20, 30, 40, 50];
    ctx.strokeStyle = colBorder;
    ctx.lineWidth = 0.5;
    xTicks.forEach((b) => {
        const x = bx(b);
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + plotH);
        ctx.stroke();
    });
    ctx.fillStyle = colMuted;
    ctx.font =
        "9px " + (styles.getPropertyValue("--font-mono").trim() || "monospace");
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    xTicks.forEach((b) => {
        const x = bx(b);
        ctx.fillText(b, x, pad.top + plotH + 3);
    });

    // Concurrency value label at current position (layered on top)
    ctx.fillStyle = colText;
    ctx.font =
        "bold 13px " + (styles.getPropertyValue("--font-mono").trim() || "monospace");
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // Background to cover tick labels underneath
    const label = String(current);
    const labelW = ctx.measureText(label).width + 6;
    ctx.fillStyle = colBg;
    ctx.fillRect(curX - labelW / 2, pad.top + plotH + 1, labelW, 15);
    ctx.fillStyle = colText;
    ctx.fillText(current, curX, pad.top + plotH + 2);

    // X-axis label
    ctx.fillStyle = colMuted;
    ctx.font =
        "12px " + (styles.getPropertyValue("--font-mono").trim() || "monospace");
    ctx.textAlign = "center";
    ctx.fillText("Build Concurrency", pad.left + plotW / 2, h - 14);
}

function initOptimalChart() {
    const canvas = document.getElementById("optimal-chart");
    if (!canvas) return;

    const tooltip = document.getElementById("optimal-chart-tooltip");

    function clientXFromEvent(e) {
        if (e.touches && e.touches.length > 0) return e.touches[0].clientX;
        if (e.changedTouches && e.changedTouches.length > 0) return e.changedTouches[0].clientX;
        return e.clientX;
    }
    function concurrencyFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        const padL = 44, padR = 8;
        const plotW = rect.width - padL - padR;
        const relX = clientXFromEvent(e) - rect.left - padL;
        const ratio = Math.max(0, Math.min(1, relX / plotW));
        return Math.round(ratio * 49) + 1; // 1-50
    }

    let dragging = false;

    function applyConcurrency(e) {
        const n = concurrencyFromEvent(e);
        document.getElementById("cfg-build-concurrency").value = n;
        readConfigFromUI();
        syncUIValues();
        if (!state.isRunning) doReset();
    }

    canvas.addEventListener("mousedown", (e) => {
        dragging = true;
        applyConcurrency(e);
        e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
        if (dragging) applyConcurrency(e);
    });

    window.addEventListener("mouseup", () => {
        dragging = false;
    });

    canvas.addEventListener("touchstart", (e) => {
        dragging = true;
        applyConcurrency(e);
        e.preventDefault();
    }, { passive: false });

    window.addEventListener("touchmove", (e) => {
        if (dragging) {
            applyConcurrency(e);
            e.preventDefault();
        }
    }, { passive: false });

    window.addEventListener("touchend", () => {
        dragging = false;
    });

    window.addEventListener("touchcancel", () => {
        dragging = false;
    });

    canvas.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        const relCanvasX = e.clientX - rect.left;
        const relCanvasY = e.clientY - rect.top;
        const padL = 44;
        const padBottom = 38;
        const inXAxisArea = relCanvasY > rect.height - padBottom;

        const wrapRect = canvas.parentElement.getBoundingClientRect();
        const relY = e.clientY - wrapRect.top;
        const tooltipAbove = relY > 50;

        // If hovering over the x-axis label area, show context tooltip
        if (inXAxisArea) {
            tooltip.innerHTML = "Number of commits processed<br>in parallel per CI cycle";
            const relX = e.clientX - wrapRect.left;
            tooltip.hidden = false;
            const tw = tooltip.offsetWidth;
            tooltip.style.left = Math.max(2, Math.min(relX - tw / 2, wrapRect.width - tw - 2)) + "px";
            tooltip.style.top = (rect.height - 80) + "px";
            tooltip.style.transform = "";
            return;
        }

        // If hovering over the y-axis label area, show context tooltip
        if (relCanvasX < padL && (chartActiveSeries === "cost" || chartActiveSeries === "wall")) {
            const msg = chartActiveSeries === "cost"
                ? "How much more CI you pay as<br>concurrency grows. 1x = one commit at a time."
                : "Estimated total wall clock<br>time to process all commits";
            tooltip.innerHTML = msg;

            tooltip.hidden = false;
            const tw = tooltip.offsetWidth;
            tooltip.style.left = Math.max(2, Math.min(padL, wrapRect.width - tw - 2)) + "px";
            tooltip.style.top = (tooltipAbove ? relY - 36 : relY + 12) + "px";
            tooltip.style.transform = "";
            return;
        }

        const n = concurrencyFromEvent(e);
        const p = config.successRate / 100;
        const pb = Math.pow(p, n);

        // Expected merges per cycle
        let em = 0;
        for (let k = 0; k < n; k++) em += k * Math.pow(p, k) * (1 - p);
        em += n * pb;

        // Items removed per cycle = merged + rejected (failed items also leave the queue)
        const removed = em + (1 - pb);
        const cycles = removed > 0.0001 ? config.totalCommits / removed : 9999;
        const wallMin = cycles * config.ciDuration;

        // Last cycle is typically a partial run; subtract ~0.5 cycles for CI runs
        const totalRuns = Math.max(1, cycles - 0.5) * n;
        const runners = getCostRunners();
        const rate = getCostRate();
        const totalCost = totalRuns * config.ciDuration * runners * rate;

        // Format wall clock time
        let wallStr;
        if (wallMin < 60) wallStr = Math.round(wallMin) + "m";
        else if (wallMin < 1440) wallStr = (wallMin / 60).toFixed(1) + "h";
        else wallStr = (wallMin / 1440).toFixed(1) + "d";

        // Format cost
        const costStr =
            totalCost >= 1
                ? "$" + Math.round(totalCost)
                : "$" + totalCost.toFixed(2);
        const mult = Math.max(1, totalRuns / config.totalCommits);
        const multStr = mult < 10 ? mult.toFixed(1) : Math.round(mult).toString();

        tooltip.innerHTML =
            "<strong>Concurrent Builds: " +
            n +
            "</strong><br>" +
            "Wall clock: ~" +
            wallStr +
            "<br>" +
            "Cost: ~" +
            costStr +
            " (" + multStr + "x)";

        const relX = e.clientX - wrapRect.left;
        const mainTooltipAbove = relY > 60;
        tooltip.hidden = false;
        const tw = tooltip.offsetWidth;
        const left = Math.max(
            2,
            Math.min(relX - tw / 2, wrapRect.width - tw - 2),
        );
        tooltip.style.left = left + "px";
        tooltip.style.top = (mainTooltipAbove ? relY - 52 : relY + 12) + "px";
        tooltip.style.transform = "";
    });

    canvas.addEventListener("mouseleave", () => {
        tooltip.hidden = true;
    });

    // Y-axis series selection (cost / wall clock)
    const seriesBtns = document.querySelectorAll("button.optimal-legend-item");
    seriesBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
            chartActiveSeries = btn.dataset.series;
            seriesBtns.forEach((b) =>
                b.classList.toggle("optimal-legend-item--active", b === btn),
            );
            renderOptimalChart();
        });
    });

    // Initial render
    renderOptimalChart();
    updateChartEstimate();
}

const SPEED_OPTIONS = [
    { speed: 240, label: "Normal" },
    { speed: 3600, label: "Fast" },
    { speed: 10800, label: "Very Fast" },
];

function syncSpeedTopbar() {
    const label = SPEED_OPTIONS.find((o) => o.speed === config.speed)?.label ?? "Normal";
    const topbar = document.getElementById("val-speed-topbar");
    const sidebar = document.getElementById("val-speed-sidebar");
    if (topbar) topbar.textContent = label;
    if (sidebar) sidebar.textContent = label;
}

function syncStepModeButtons() {
    const html = '<span class="btn-icon">⏭</span> Step: ' + (config.stepMode ? "On" : "Off");
    const topbar = document.getElementById("btn-step-mode");
    const sidebar = document.getElementById("btn-step-mode-sidebar");
    if (topbar) {
        topbar.classList.toggle("btn-step-active", config.stepMode);
        topbar.classList.toggle("btn-ghost", !config.stepMode);
        topbar.innerHTML = html;
    }
    if (sidebar) {
        sidebar.classList.toggle("btn-step-active", config.stepMode);
        sidebar.classList.toggle("btn-ghost", !config.stepMode);
        sidebar.innerHTML = html;
    }
}

function openSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const backdrop = document.getElementById("sidebar-backdrop");
    if (sidebar) sidebar.classList.add("sidebar--open");
    if (backdrop) {
        backdrop.hidden = false;
        backdrop.classList.add("sidebar-backdrop--visible");
    }
    document.body.style.overflow = "hidden";
}

function closeSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const backdrop = document.getElementById("sidebar-backdrop");
    if (sidebar) sidebar.classList.remove("sidebar--open");
    if (backdrop) {
        backdrop.classList.remove("sidebar-backdrop--visible");
        backdrop.hidden = true;
    }
    document.body.style.overflow = "";
}

function syncSpeedButtons() {
    document.querySelectorAll(".speed-btn").forEach((btn) => {
        btn.classList.toggle("speed-btn--active", +btn.dataset.speed === config.speed);
    });
    syncSpeedTopbar();
}

function syncUIValues() {
    const srInput = document.getElementById("val-success-rate-input");
    if (document.activeElement !== srInput) {
        srInput.value = Number.isInteger(config.successRate)
            ? config.successRate.toFixed(1)
            : parseFloat(config.successRate.toFixed(1));
    }
    document.getElementById("val-build-concurrency").textContent = config.buildConcurrency;
    document.getElementById("val-total-commits").textContent =
        config.totalCommits;
    document.getElementById("val-ci-duration").textContent =
        config.ciDuration + " m";
    document.getElementById("val-ci-jitter").textContent =
        "± " + config.ciJitter + " m";
    document.getElementById("val-optimal-concurrency").textContent =
        getOptimalConcurrency();
    renderOptimalChart();
    updateChartEstimate();
}

function getActivePreset() {
    for (const [name, p] of Object.entries(PRESETS)) {
        if (
            config.successRate === p.successRate &&
            config.buildConcurrency === p.buildConcurrency &&
            config.totalCommits === p.totalCommits &&
            config.ciDuration === p.ciDuration &&
            config.ciJitter === p.ciJitter &&
            config.speed === p.speed
        ) {
            return name;
        }
    }
    return null;
}

function updatePresetButtonStates() {
    const active = getActivePreset();
    document.querySelectorAll(".preset-btn").forEach((btn) => {
        btn.classList.toggle("preset-btn--selected", btn.dataset.preset === active);
    });
}

function writeConfigToUI() {
    document.getElementById("cfg-success-rate").value = config.successRate;
    document.getElementById("cfg-build-concurrency").value = config.buildConcurrency;
    document.getElementById("cfg-total-commits").value = config.totalCommits;
    document.getElementById("cfg-ci-duration").value = config.ciDuration;
    document.getElementById("cfg-ci-jitter").value = config.ciJitter;
    syncSpeedButtons();
    syncUIValues();
    updatePresetButtonStates();
}

function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    config.successRate = p.successRate;
    config.buildConcurrency = p.buildConcurrency;
    config.totalCommits = p.totalCommits;
    config.ciDuration = p.ciDuration;
    config.ciJitter = p.ciJitter;
    config.speed = p.speed;
    writeConfigToUI();
    saveConfig();
    doReset();
}

// ── Event Binding ──────────────────────────────

function bindEvents() {
    // Simulation controls
    document.getElementById("btn-start").addEventListener("click", toggleRun);
    document.getElementById("btn-reset").addEventListener("click", doReset);

    function toggleStepMode() {
        config.stepMode = !config.stepMode;
        syncStepModeButtons();
        saveConfig();
        if (!config.stepMode && state.stepWaiting && !state.animating) {
            hideStepBanner();
            state.stepWaiting = false;
            evaluateQueue();
            lastTimestamp = 0;
        }
    }

    function cycleSpeed() {
        const idx = SPEED_OPTIONS.findIndex((o) => o.speed === config.speed);
        const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
        config.speed = next.speed;
        syncSpeedButtons();
        saveConfig();
        updatePresetButtonStates();
    }

    document.getElementById("btn-step-mode").addEventListener("click", toggleStepMode);
    const stepSidebar = document.getElementById("btn-step-mode-sidebar");
    if (stepSidebar) stepSidebar.addEventListener("click", toggleStepMode);

    document.getElementById("btn-speed-topbar").addEventListener("click", cycleSpeed);
    const speedSidebar = document.getElementById("btn-speed-sidebar");
    if (speedSidebar) speedSidebar.addEventListener("click", cycleSpeed);

    document
        .getElementById("btn-step-continue")
        .addEventListener("click", doStepContinue);

    // Desktop: click anywhere on overlay to continue
    document
        .getElementById("step-overlay")
        .addEventListener("click", doStepContinue);

    // Mobile sidebar
    const menuBtn = document.getElementById("btn-menu");
    if (menuBtn) menuBtn.addEventListener("click", openSidebar);
    const sidebarClose = document.getElementById("btn-sidebar-close");
    if (sidebarClose) sidebarClose.addEventListener("click", closeSidebar);
    const sidebarBackdrop = document.getElementById("sidebar-backdrop");
    if (sidebarBackdrop) sidebarBackdrop.addEventListener("click", closeSidebar);
    window.addEventListener("resize", () => {
        if (window.innerWidth >= 1000) closeSidebar();
    });

    // Instant mode button
    document.getElementById("btn-instant").addEventListener("click", () => {
        // Reset first if a simulation already ran, then run instantly
        if (
            state.isRunning ||
            state.merged.length > 0 ||
            state.rejected.length > 0
        ) {
            doReset();
        }
        runInstant();
    });

    // Optimal concurrency button
        document
            .getElementById("btn-optimal-concurrency")
            .addEventListener("click", () => {
                const optimal = getOptimalConcurrency();
                document.getElementById("cfg-build-concurrency").value = optimal;
                readConfigFromUI();
                syncUIValues();
                if (!state.isRunning) doReset();
            });

    // Speed buttons
    document.querySelectorAll(".speed-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            config.speed = +btn.dataset.speed;
            syncSpeedButtons();
            saveConfig();
            updatePresetButtonStates();
        });
    });

    // Sidebar sliders: live update labels; some require reset
    const liveSliders = ["cfg-success-rate"];
    const resetSliders = [
        "cfg-build-concurrency",
        "cfg-total-commits",
        "cfg-ci-duration",
        "cfg-ci-jitter",
    ];

    liveSliders.forEach((id) => {
        document.getElementById(id).addEventListener("input", () => {
            readConfigFromUI();
            syncUIValues();
        });
    });

    // Success rate number input: syncs with slider
    const srInput = document.getElementById("val-success-rate-input");
    srInput.addEventListener("input", () => {
        let val = parseFloat(srInput.value);
        if (isNaN(val)) return;
        val = Math.max(0, Math.min(100, val));
        document.getElementById("cfg-success-rate").value = val;
        readConfigFromUI();
        syncUIValues();
    });
    srInput.addEventListener("blur", () => {
        srInput.value = config.successRate.toFixed(1);
    });

    resetSliders.forEach((id) => {
        document.getElementById(id).addEventListener("input", () => {
            readConfigFromUI();
            syncUIValues();
            // If not running, auto-apply by resetting
            if (!state.isRunning) {
                doReset();
            }
        });
    });

    // Presets
    document.querySelectorAll(".preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            applyPreset(btn.dataset.preset);
        });
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
        if (e.target.tagName === "INPUT") return;
        // Close sidebar on Escape
        if (e.code === "Escape") {
            const sidebar = document.querySelector(".sidebar");
            if (sidebar?.classList.contains("sidebar--open")) {
                closeSidebar();
                e.preventDefault();
                return;
            }
        }
        // Don't handle shortcuts while welcome dialog is open
        const welcome = document.getElementById("welcome-overlay");
        if (welcome && !welcome.hidden) return;
        if (e.code === "Space") {
            e.preventDefault();
            state.stepWaiting ? doStepContinue() : toggleRun();
        }
        if (e.code === "Enter" && state.stepWaiting) {
            e.preventDefault();
            doStepContinue();
        }
        if (e.code === "KeyR") {
            doReset();
        }
    });
}

// ── Welcome Dialog ─────────────────────────────

const WELCOME_KEY = "ghmq-welcome-seen";

const welcome = {
    overlay: null,
    steps: null,
    dots: null,
    nextBtn: null,
    currentStep: 0,
    totalSteps: 7,
};

function openWelcome() {
    const w = welcome;
    w.currentStep = 0;
    // Reset all steps to initial state
    w.steps.forEach((s, i) => {
        s.hidden = i !== 0;
    });
    w.dots.forEach((d, i) => {
        d.classList.toggle("welcome-dot-btn--active", i === 0);
    });
    w.nextBtn.textContent = "Next →";
    if (w.backBtn) w.backBtn.hidden = true;
    w.overlay.hidden = false;
    // Re-trigger entrance animation
    w.overlay.classList.remove("welcome-overlay--closing");
    w.overlay.style.animation = "none";
    void w.overlay.offsetWidth;
    w.overlay.style.animation = "";
    w.nextBtn.focus();
}

function closeWelcome() {
    localStorage.setItem(WELCOME_KEY, "1");
    welcome.overlay.classList.add("welcome-overlay--closing");
    setTimeout(() => {
        welcome.overlay.hidden = true;
        welcome.overlay.classList.remove("welcome-overlay--closing");
    }, 300);
}

function welcomeGoToStep(idx) {
    const w = welcome;
    if (idx < 0 || idx >= w.totalSteps) return;
    w.steps[w.currentStep].hidden = true;
    w.currentStep = idx;
    w.steps[w.currentStep].hidden = false;
    // Re-trigger animation
    w.steps[w.currentStep].style.animation = "none";
    void w.steps[w.currentStep].offsetWidth;
    w.steps[w.currentStep].style.animation = "";

    w.dots.forEach((d, i) => {
        d.classList.toggle("welcome-dot-btn--active", i === w.currentStep);
    });

    if (w.currentStep === w.totalSteps - 1) {
        w.nextBtn.textContent = "Get Started →";
    } else {
        w.nextBtn.textContent = "Next →";
    }
    if (w.backBtn) w.backBtn.hidden = w.currentStep === 0;
    w.nextBtn.focus();
}

function initGlossary() {
    const overlay = document.getElementById("glossary-overlay");
    const closeBtn = document.getElementById("glossary-close");
    const openBtn = document.getElementById("btn-glossary");
    const searchInput = document.getElementById("glossary-search");
    const body = document.getElementById("glossary-body");
    const noResults = document.getElementById("glossary-no-results");
    if (!overlay) return;

    const entries = overlay.querySelectorAll(".glossary-entry");
    const sectionGroups = overlay.querySelectorAll(".glossary-section-group");
    const navItems = overlay.querySelectorAll(".glossary-nav-item");

    function getSearchableText(entry) {
        const term = entry.querySelector(".glossary-term");
        const def = entry.querySelector(".glossary-def");
        const extra = entry.getAttribute("data-term") || "";
        return [(term?.textContent || ""), (def?.textContent || ""), extra].join(" ").toLowerCase();
    }

    function filterGlossary() {
        const q = (searchInput?.value || "").trim().toLowerCase();
        let visibleCount = 0;

        entries.forEach((entry) => {
            const text = getSearchableText(entry);
            const matches = !q || text.includes(q);
            entry.classList.toggle("glossary-entry--hidden", !matches);
            if (matches) visibleCount++;
        });

        sectionGroups.forEach((group) => {
            const hasVisible = group.querySelectorAll(".glossary-entry:not(.glossary-entry--hidden)").length > 0;
            group.classList.toggle("glossary-section-group--hidden", !hasVisible && !!q);
        });

        if (noResults) {
            noResults.hidden = visibleCount > 0 || !q;
        }
    }

    function scrollToSection(sectionId) {
        const section = document.getElementById(sectionId);
        if (section && body) {
            section.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }

    function setActiveNav(sectionId) {
        navItems.forEach((item) => {
            item.classList.toggle("glossary-nav-item--active", item.getAttribute("data-section") === sectionId);
        });
    }

    function showGlossary() {
        overlay.hidden = false;
        if (searchInput) {
            searchInput.value = "";
            filterGlossary();
            if (!window.matchMedia("(max-width: 1000px)").matches) {
                searchInput.focus();
            }
        }
        setActiveNav("section-github");
    }

    function hideGlossary() {
        overlay.hidden = true;
    }

    if (searchInput) {
        searchInput.addEventListener("input", filterGlossary);
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                searchInput.value = "";
                filterGlossary();
                searchInput.blur();
            }
        });
    }

    const SELECTING_DURATION_MS = 400;
    let scrollUpdatesPausedUntil = 0;

    navItems.forEach((item) => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            const sectionId = item.getAttribute("data-section");
            item.classList.add("glossary-nav-item--selecting");
            scrollToSection(sectionId);
            setActiveNav(sectionId);
            scrollUpdatesPausedUntil = performance.now() + SELECTING_DURATION_MS;
            setTimeout(() => {
                item.classList.remove("glossary-nav-item--selecting");
            }, SELECTING_DURATION_MS);
        });
    });

    if (body) {
        body.addEventListener("scroll", () => {
            if (performance.now() < scrollUpdatesPausedUntil) return;
            const sections = body.querySelectorAll(".glossary-section-group:not(.glossary-section-group--hidden)");
            for (const section of sections) {
                const rect = section.getBoundingClientRect();
                const bodyRect = body.getBoundingClientRect();
                if (rect.top <= bodyRect.top + 80 && rect.bottom > bodyRect.top + 80) {
                    setActiveNav(section.id);
                    break;
                }
            }
        });
    }

    if (openBtn) openBtn.addEventListener("click", showGlossary);
    if (closeBtn) closeBtn.addEventListener("click", hideGlossary);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) hideGlossary();
    });
}

function initWelcome() {
    const overlay = document.getElementById("welcome-overlay");
    if (!overlay) return;

    welcome.overlay = overlay;
    welcome.steps = overlay.querySelectorAll(".welcome-step");
    welcome.dots = overlay.querySelectorAll(".welcome-dot-btn");
    welcome.nextBtn = document.getElementById("welcome-next");
    const skipBtn = document.getElementById("welcome-skip");

    // If already seen, hide immediately
    if (localStorage.getItem(WELCOME_KEY)) {
        overlay.hidden = true;
    }

    const backBtn = document.getElementById("welcome-back");
    welcome.backBtn = backBtn;

    welcome.nextBtn.addEventListener("click", () => {
        if (welcome.currentStep < welcome.totalSteps - 1) {
            welcomeGoToStep(welcome.currentStep + 1);
        } else {
            closeWelcome();
        }
    });

    backBtn.addEventListener("click", () => {
        if (welcome.currentStep > 0) {
            welcomeGoToStep(welcome.currentStep - 1);
        }
    });

    skipBtn.addEventListener("click", closeWelcome);

    welcome.dots.forEach((dot) => {
        dot.addEventListener("click", () => {
            welcomeGoToStep(+dot.dataset.dot);
        });
    });

    overlay.addEventListener("keydown", (e) => {
        if (
            e.code === "ArrowRight" ||
            e.code === "Space" ||
            e.code === "Enter"
        ) {
            e.preventDefault();
            e.stopPropagation();
            if (welcome.currentStep < welcome.totalSteps - 1) {
                welcomeGoToStep(welcome.currentStep + 1);
            } else {
                closeWelcome();
            }
        }
        if (e.code === "ArrowLeft" && welcome.currentStep > 0) {
            e.preventDefault();
            welcomeGoToStep(welcome.currentStep - 1);
        }
        if (e.code === "Escape") {
            closeWelcome();
        }
    });

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeWelcome();
        const presetCard = e.target.closest(".preset-btn[data-preset]");
        if (presetCard) {
            applyPreset(presetCard.dataset.preset);
            closeWelcome();
        }
    });

    // Help button in sidebar
    document.getElementById("btn-help").addEventListener("click", () => {
        localStorage.removeItem(WELCOME_KEY);
        openWelcome();
    });
}

// ── Initialize ─────────────────────────────────

function initTheme() {
    const saved = localStorage.getItem("mq-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);

    function toggleTheme() {
        const current = document.documentElement.getAttribute("data-theme");
        const next = current === "light" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("mq-theme", next);
        // Redraw the chart with new theme colors
        renderOptimalChart();
    }

    document.getElementById("btn-theme").addEventListener("click", toggleTheme);
    const welcomeThemeBtn = document.getElementById("btn-theme-welcome");
    if (welcomeThemeBtn) welcomeThemeBtn.addEventListener("click", toggleTheme);
}

function initCollapsible() {
    const STORAGE_KEY = "ghmq-collapsed";
    const DEFAULTS = { "ci-env": true, "presets": true };
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (_) {}
    const collapsed = saved !== null ? saved : DEFAULTS;

    document.querySelectorAll(".collapsible-section").forEach((section) => {
        const key = section.dataset.section;
        if (collapsed[key]) section.classList.add("collapsed");

        section.querySelector(".section-toggle").addEventListener("click", () => {
            section.classList.toggle("collapsed");
            const allState = {};
            document.querySelectorAll(".collapsible-section").forEach((s) => {
                if (s.classList.contains("collapsed")) allState[s.dataset.section] = true;
            });
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(allState));
            } catch (_) {}

            // Re-render chart if analysis section was just expanded
            if (key === "analysis" && !section.classList.contains("collapsed")) {
                requestAnimationFrame(() => renderOptimalChart());
            }
        });
    });
}

function init() {
    initTheme();
    loadConfig();
    writeConfigToUI();
    syncStepModeButtons();
    bindEvents();
    initCollapsible();
    initSummary();
    initGlossary();
    initOptimalChart();
    doReset();
    initWelcome();
}

document.addEventListener("DOMContentLoaded", init);
