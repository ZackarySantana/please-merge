/* ============================================
   GitHub Merge Queue Simulator
   ============================================ */

// ── Constants ──────────────────────────────────

const PREFIXES = [
  'Fix', 'Feat', 'Refactor', 'Chore', 'Perf',
  'Test', 'Docs', 'Style', 'CI', 'Build',
];

const SUBJECTS = [
  'auth flow', 'user dashboard', 'rate limiting', 'DB migrations',
  'search indexing', 'file uploads', 'notifications', 'cache layer',
  'session mgmt', 'error handling', 'input validation', 'logging',
  'webhook delivery', 'payment flow', 'email templates', 'dark mode',
  'accessibility', 'mobile layout', 'type safety', 'test coverage',
  'CI pipeline', 'Docker config', 'env variables', 'SSL renewal',
  'rate limiter', 'retry logic', 'batch jobs', 'data export',
  'user roles', 'audit log', 'health checks', 'metrics endpoint',
  'GraphQL schema', 'REST API', 'WebSocket handler', 'queue worker',
  'image optimize', 'lazy loading', 'code splitting', 'tree shaking',
  'memory leak', 'race condition', 'deadlock fix', 'conn pooling',
  'password hash', 'token refresh', 'CORS policy', 'CSP headers',
  'i18n support', 'timezone fix', 'date formatting', 'currency fmt',
  'pagination', 'sorting logic', 'filter engine', 'search parser',
  'OAuth2 flow', 'SSO integration', '2FA setup', 'key rotation',
  'S3 uploads', 'CDN config', 'DNS records', 'load balancer',
  'cron jobs', 'event bus', 'pub/sub layer', 'state machine',
];

const PRESETS = {
  'mostly-green': {
    successRate: 95,
    batchSize: 10,
    totalCommits: 100,
    ciDuration: 10,
    ciJitter: 5,
    speed: 300,
    label: 'Mostly Green',
  },
  'flaky-ci': {
    successRate: 50,
    batchSize: 10,
    totalCommits: 100,
    ciDuration: 15,
    ciJitter: 10,
    speed: 300,
    label: 'Flaky CI',
  },
  'disaster': {
    successRate: 15,
    batchSize: 10,
    totalCommits: 60,
    ciDuration: 20,
    ciJitter: 10,
    speed: 600,
    label: 'Disaster Mode',
  },
  'fast-and-furious': {
    successRate: 80,
    batchSize: 20,
    totalCommits: 200,
    ciDuration: 5,
    ciJitter: 3,
    speed: 1200,
    label: 'Fast & Furious',
  },
};

// ── Configuration ──────────────────────────────

const config = {
  successRate: 70,
  batchSize: 10,
  totalCommits: 100,
  ciDuration: 15,  // minutes — base CI duration
  ciJitter: 10,    // minutes — ± variance around ciDuration
  speed: 60,
  stepMode: true,
};

// ── State ──────────────────────────────────────

const state = {
  commits: new Map(),   // id → commit object
  queue: [],            // ordered ids: [0]=oldest (HEAD)
  merged: [],           // ids, newest push()ed last
  rejected: [],         // ids, newest push()ed last
  totalReruns: 0,       // total duplicate CI runs across all commits
  wastedCITime: 0,      // ms — CI time lost to restarts + failures
  successCITime: 0,     // ms — CI time spent on successful merges
  wallClockTime: 0,     // ms — total simulated time elapsed
  sequentialCITime: 0,  // ms — sum of all CI durations ever assigned (sequential baseline)
  isRunning: false,
  isPaused: false,
  stepWaiting: false,   // true when step mode has paused before evaluation
  animating: false,     // true during step-mode transition animation
  previousRun: null,    // snapshot of last completed run for comparison
};

// Render bookkeeping (to do incremental DOM updates)
const render = {
  mergedCount: 0,       // how many merged cards already in DOM
  rejectedCount: 0,     // how many rejected cards already in DOM
  queueDirty: true,     // full queue re-render needed
};

let animFrameId = null;
let lastTimestamp = 0;

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
      ciStatus: 'idle',     // idle | running | success | fail
      ciDuration: 0,        // ms — assigned when CI starts
      ciElapsed: 0,         // ms
      ciOutcome: null,       // predetermined: 'success' | 'fail'
      ciRuns: 0,            // how many times CI has been started
      firstRunDuration: 0,  // ms — duration from the very first CI run (for sequential baseline)
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
  if (s < 60) return s.toFixed(0) + 's';
  const m = s / 60;
  if (m < 60) return m.toFixed(1).replace(/\.0$/, '') + 'm';
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  return rem > 0 ? h + 'h ' + rem + 'm' : h + 'h';
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function flashHeader(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.classList.remove('flash');
  // Force reflow to restart animation
  void el.offsetWidth;
  el.classList.add('flash');
}

// ── Simulation Engine ──────────────────────────

function startCI(commit) {
  const baseMs = config.ciDuration * 60000;  // minutes → ms
  const jitterMs = config.ciJitter * 60000;  // minutes → ms
  const minMs = Math.max(30000, baseMs - jitterMs); // floor at 30s
  const maxMs = baseMs + jitterMs;
  commit.ciStatus = 'running';
  commit.ciElapsed = 0;
  commit.ciDuration = rand(minMs, maxMs);
  commit.ciOutcome = Math.random() * 100 < config.successRate ? 'success' : 'fail';
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
  const originalActiveSize = Math.min(config.batchSize, originalQueueLen);
  const remaining = Math.max(0, originalActiveSize - alreadyRemoved);
  let wasted = 0;
  for (let i = 0; i < remaining; i++) {
    const c = state.commits.get(state.queue[i]);
    // Running commits: their elapsed time is wasted
    if (c.ciStatus === 'running' && c.ciElapsed > 0) {
      wasted += c.ciElapsed;
    }
    // Completed commits (success waiting to merge, or another fail behind head):
    // their full CI duration is thrown away
    if ((c.ciStatus === 'success' || c.ciStatus === 'fail') && c.ciDuration > 0) {
      wasted += c.ciDuration;
    }
    c.ciStatus = 'idle';
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

  const activeSize = Math.min(config.batchSize, state.queue.length);

  // 1. Start CI for idle active commits
  let anyStarted = false;
  for (let i = 0; i < activeSize; i++) {
    const c = state.commits.get(state.queue[i]);
    if (c.ciStatus === 'idle') {
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
    if (c.ciStatus === 'running') {
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
    const headReady = head && (head.ciStatus === 'success' || head.ciStatus === 'fail');

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

    if (c.ciStatus === 'success') {
      state.queue.shift();
      shifted++;
      state.merged.push(id);
      state.successCITime += c.ciDuration;
      state.sequentialCITime += c.firstRunDuration;
      usefulDelta += c.ciDuration;
      moved = true;
      continue;
    }

    if (c.ciStatus === 'fail') {
      state.queue.shift();
      shifted++;
      state.rejected.push(id);
      state.sequentialCITime += c.firstRunDuration;
      moved = true;
      // Restart remaining active window (pass how many were already removed)
      wastedDelta += restartActiveWindow(shifted);
      break; // stop — new CIs will start next frame
    }

    // Still running or idle — can't proceed
    break;
  }

  if (moved) {
    render.queueDirty = true;
    renderMergedIncremental();
    renderRejectedIncremental();
    updateStats();

    // Floating deltas in non-step mode
    if (usefulDelta > 0) {
      showStatDelta('stat-ci-useful', usefulDelta, 'var(--green-bright)');
    }
    if (wastedDelta > 0) {
      showStatDelta('stat-ci-wasted', wastedDelta, 'var(--red)');
    }

    // Flash lane headers for visual feedback
    if (state.merged.length > render.mergedCount) {
      flashHeader('.lane-header--merged');
    }
    if (state.rejected.length > render.rejectedCount) {
      flashHeader('.lane-header--rejected');
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
    if (c.ciStatus === 'success') {
      state.queue.shift();
      shifted++;
      state.merged.push(c.id);
      state.successCITime += c.ciDuration;
      state.sequentialCITime += c.firstRunDuration;
      usefulDelta += c.ciDuration;
      moved = true;
      continue;
    }
    break; // stop at first non-success — don't process a failure here
  }

  // If no successes were processed, try a single failure
  if (!moved && state.queue.length > 0) {
    const c = state.commits.get(state.queue[0]);
    if (c.ciStatus === 'fail') {
      state.queue.shift();
      shifted++;
      state.rejected.push(c.id);
      state.sequentialCITime += c.firstRunDuration;
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
      flashHeader('.lane-header--merged');
    }
    if (state.rejected.length > render.rejectedCount) {
      flashHeader('.lane-header--rejected');
    }
    render.mergedCount = state.merged.length;
    render.rejectedCount = state.rejected.length;
  }

  return { moved, usefulDelta, wastedDelta };
}

// ── Step Mode ──────────────────────────────────

function previewEvaluation() {
  // Scan the head of the queue to describe what will happen
  if (state.queue.length === 0) return { action: 'none' };

  const head = state.commits.get(state.queue[0]);
  if (head.ciStatus === 'fail') {
    // Preview wasted time: scan remaining active window (after head is removed)
    // Only check items that were actually in the original active window (minus the head)
    const remaining = state.queue.slice(1);
    const windowSize = Math.max(0, Math.min(config.batchSize, state.queue.length) - 1);
    let wastedPreview = 0;
    for (let i = 0; i < windowSize; i++) {
      const c = state.commits.get(remaining[i]);
      if (c.ciStatus === 'running' && c.ciElapsed > 0) {
        wastedPreview += c.ciElapsed;
      } else if ((c.ciStatus === 'success' || c.ciStatus === 'fail') && c.ciDuration > 0) {
        wastedPreview += c.ciDuration;
      }
    }
    return {
      action: 'reject',
      commit: head,
      wastedDelta: wastedPreview,
      description: `Reject "${head.name}". CI failed. Remaining active window will restart CI.`,
    };
  }

  if (head.ciStatus === 'success') {
    // Count consecutive successes from head and sum their CI time
    let count = 0;
    let usefulPreview = 0;
    for (let i = 0; i < state.queue.length; i++) {
      const c = state.commits.get(state.queue[i]);
      if (c.ciStatus === 'success') {
        count++;
        usefulPreview += c.ciDuration;
      } else {
        break;
      }
    }
    const names = state.queue.slice(0, count).map(id => state.commits.get(id).name);
    const preview = count === 1
      ? `Merge "${names[0]}" into main.`
      : `Merge ${count} commits into main: ${names.slice(0, 3).join(', ')}${count > 3 ? ` (+${count - 3} more)` : ''}.`;
    return {
      action: 'merge',
      count,
      usefulDelta: usefulPreview,
      description: preview,
    };
  }

  return { action: 'none' };
}

function showStepBanner() {
  const banner = document.getElementById('step-banner');
  const icon = document.getElementById('step-banner-icon');
  const title = document.getElementById('step-banner-title');
  const desc = document.getElementById('step-banner-desc');

  const preview = previewEvaluation();

  if (preview.action === 'merge') {
    icon.textContent = '✓';
    icon.className = 'step-banner-icon step-banner-icon--merge';
    title.textContent = preview.count === 1 ? 'Ready to merge 1 commit' : `Ready to merge ${preview.count} commits`;
    title.style.color = 'var(--green-bright)';
    const timeTag = preview.usefulDelta > 0 ? `  ·  Useful CI: +${formatCITime(preview.usefulDelta)}` : '';
    desc.innerHTML = preview.description + `<span class="step-banner-time step-banner-time--useful">${timeTag}</span>`;
  } else if (preview.action === 'reject') {
    icon.textContent = '✕';
    icon.className = 'step-banner-icon step-banner-icon--reject';
    title.textContent = 'Head commit failed. Reject & restart.';
    title.style.color = 'var(--red)';
    const timeTag = preview.wastedDelta > 0 ? `  ·  Wasted CI: +${formatCITime(preview.wastedDelta)}` : '';
    desc.innerHTML = preview.description + `<span class="step-banner-time step-banner-time--wasted">${timeTag}</span>`;
  }

  banner.hidden = false;
}

function hideStepBanner() {
  const banner = document.getElementById('step-banner');
  banner.hidden = true;
}

function doStepContinue() {
  if (!state.stepWaiting || state.animating) return;
  hideStepBanner();

  const preview = previewEvaluation();
  if (preview.action === 'none') {
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

      // Check if the new head is also ready — if so, pause again (only if step mode still on)
      if (config.stepMode && state.queue.length > 0) {
        const newHead = state.commits.get(state.queue[0]);
        if (newHead && (newHead.ciStatus === 'success' || newHead.ciStatus === 'fail')) {
          showStepBanner();
          return; // stepWaiting stays true
        }
      }

      // Nothing more to evaluate right now — resume simulation
      state.stepWaiting = false;
      lastTimestamp = 0;
    });
  });
}

// ── Step Animation ─────────────────────────────

function animateStepTransition(preview, onComplete) {
  const queueBody = document.getElementById('lane-queue');
  const isReject = preview.action === 'reject';
  const targetId = isReject ? 'lane-rejected' : 'lane-merged';
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
  const stagger = Math.min(60, 300 / sourceCards.length); // tighter stagger for large batches

  // Create fixed-position clones that will fly to the target lane
  const clones = sourceCards.map((card, i) => {
    const rect = card.getBoundingClientRect();
    const clone = card.cloneNode(true);

    // Strip progress bar from clone for a cleaner flight
    const progress = clone.querySelector('.card-progress');
    if (progress) progress.remove();

    clone.classList.add('card-clone-flying');
    Object.assign(clone.style, {
      position: 'fixed',
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      zIndex: String(1000 - i),
      margin: '0',
      pointerEvents: 'none',
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
      opacity: '0.1',
      transform: 'scale(0.95)',
      transition: 'opacity 250ms ease, transform 250ms ease',
    });

    return { clone, rect };
  });

  // Trigger the fly on next frame (ensures transition fires)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      clones.forEach(({ clone }) => {
        Object.assign(clone.style, {
          top: (targetRect.top + 6) + 'px',
          left: (targetRect.left + 6) + 'px',
          width: (targetRect.width - 12) + 'px',
          opacity: '0',
          transform: 'scale(0.92)',
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
  const queueBody = document.getElementById('lane-queue');
  const limit = Math.min(config.batchSize + 5, queueBody.children.length);

  for (let i = 0; i < limit; i++) {
    const card = queueBody.children[i];
    card.classList.add('card--shifting');
    card.style.animationDelay = `${i * 25}ms`;
  }

  const cleanupTime = 350 + limit * 25 + 50;
  setTimeout(() => {
    queueBody.querySelectorAll('.card--shifting').forEach(c => {
      c.classList.remove('card--shifting');
      c.style.animationDelay = '';
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
  const maxIterations = config.totalCommits * config.batchSize * 10;

  while (state.queue.length > 0 && iterations < maxIterations) {
    iterations++;
    const activeSize = Math.min(config.batchSize, state.queue.length);

    // Start CI for idle active commits
    for (let i = 0; i < activeSize; i++) {
      const c = state.commits.get(state.queue[i]);
      if (c.ciStatus === 'idle') {
        startCI(c);
      }
    }

    // Find the shortest running CI in the active window (time to next event)
    let minRemaining = Infinity;
    for (let i = 0; i < activeSize; i++) {
      const c = state.commits.get(state.queue[i]);
      if (c.ciStatus === 'running') {
        const remaining = c.ciDuration - c.ciElapsed;
        if (remaining < minRemaining) minRemaining = remaining;
      }
    }
    if (minRemaining === Infinity) break; // nothing running

    // Advance all running CIs by that amount
    state.wallClockTime += minRemaining;
    for (let i = 0; i < activeSize; i++) {
      const c = state.commits.get(state.queue[i]);
      if (c.ciStatus === 'running') {
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

function doReset() {
  state.isRunning = false;
  state.isPaused = false;
  state.stepWaiting = false;
  state.animating = false;
  hideStepBanner();
  hideSummary();
  hideSummaryButton();
  // Clean up any in-flight animation clones
  document.querySelectorAll('.card-clone-flying').forEach(el => el.remove());
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
      batchSize: config.batchSize,
      reruns: state.totalReruns,
      wallClockTime: state.wallClockTime,
      sequentialCITime: state.sequentialCITime,
      successCITime: state.successCITime,
      wastedCITime: state.wastedCITime,
      totalCost: (state.successCITime + state.wastedCITime) * toMin * costPerMin,
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
  document.getElementById('lane-merged').innerHTML = '';
  document.getElementById('lane-rejected').innerHTML = '';

  renderQueue();
  updateStats();
  updateButtons();
}

function updateButtons() {
  const startBtn = document.getElementById('btn-start');
  const pauseBtn = document.getElementById('btn-pause');
  const sumStartBtn = document.getElementById('summary-start');
  const sumPauseBtn = document.getElementById('summary-pause');

  if (state.isRunning && !state.isPaused) {
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    if (sumStartBtn) sumStartBtn.disabled = true;
    if (sumPauseBtn) sumPauseBtn.disabled = false;
  } else if (state.isRunning && state.isPaused) {
    startBtn.disabled = false;
    startBtn.querySelector('.btn-icon').textContent = '▶';
    startBtn.lastChild.textContent = ' Resume';
    pauseBtn.disabled = true;
    if (sumStartBtn) {
      sumStartBtn.disabled = false;
      sumStartBtn.querySelector('.btn-icon').textContent = '▶';
      sumStartBtn.lastChild.textContent = ' Resume';
    }
    if (sumPauseBtn) sumPauseBtn.disabled = true;
  } else {
    startBtn.disabled = state.queue.length === 0;
    startBtn.querySelector('.btn-icon').textContent = '▶';
    startBtn.lastChild.textContent = ' Start';
    pauseBtn.disabled = true;
    if (sumStartBtn) {
      sumStartBtn.disabled = state.queue.length === 0;
      sumStartBtn.querySelector('.btn-icon').textContent = '▶';
      sumStartBtn.lastChild.textContent = ' Start';
    }
    if (sumPauseBtn) sumPauseBtn.disabled = true;
  }
}

// ── Rendering: Queue ───────────────────────────

function renderQueue() {
  const container = document.getElementById('lane-queue');
  const activeSize = Math.min(config.batchSize, state.queue.length);

  // Build all cards as HTML string (fast for bulk rendering)
  const fragments = [];
  for (let i = 0; i < state.queue.length; i++) {
    const id = state.queue[i];
    const c = state.commits.get(id);
    const isActive = i < activeSize;
    fragments.push(buildQueueCard(c, isActive));
  }
  container.innerHTML = fragments.join('');

  document.getElementById('count-queue').textContent = state.queue.length;
}

function buildQueueCard(commit, isActive) {
  const runsTag = commit.ciRuns > 1
    ? `<span class="card-runs" title="This commit has run CI ${commit.ciRuns} times. It was restarted ${commit.ciRuns - 1}x due to earlier failures in the queue.">⟳${commit.ciRuns}</span>`
    : '';

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
  const pct = commit.ciDuration > 0 ? Math.min(100, (commit.ciElapsed / commit.ciDuration) * 100) : 0;

  let badge = '';
  let timeStr = '';

  if (commit.ciStatus === 'running') {
    timeStr = `<span class="card-time">${formatCardTime(commit.ciElapsed)}/${formatCardTime(commit.ciDuration)}</span>`;
  } else if (commit.ciStatus === 'success') {
    badge = '<span class="card-badge">✓</span>';
    timeStr = `<span class="card-time">${formatCardTime(commit.ciDuration)}</span>`;
  } else if (commit.ciStatus === 'fail') {
    badge = '<span class="card-badge">✕</span>';
    timeStr = `<span class="card-time">${formatCardTime(commit.ciDuration)}</span>`;
  }

  // Progress bar always visible — fill class varies by status
  const fillClass = commit.ciStatus === 'success' ? 'card-progress-fill card-progress-fill--success'
    : commit.ciStatus === 'fail' ? 'card-progress-fill card-progress-fill--fail'
    : 'card-progress-fill';
  const fillPct = (commit.ciStatus === 'success' || commit.ciStatus === 'fail') ? 100 : pct;

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
  const container = document.getElementById('lane-merged');
  for (let i = render.mergedCount; i < state.merged.length; i++) {
    const c = state.commits.get(state.merged[i]);
    const runsTag = c.ciRuns > 1
      ? `<span class="card-runs" title="This commit ran CI ${c.ciRuns} times. It was restarted ${c.ciRuns - 1}x due to earlier failures in the queue.">⟳${c.ciRuns}</span>`
      : '';
    const card = document.createElement('div');
    card.className = 'card card--merged card--entering';
    card.dataset.id = c.id;
    card.innerHTML = `
      <div class="card-row">
        <span class="card-dot"></span>
        <span class="card-name">${c.name}</span>
        ${runsTag}
        <span class="card-badge">✓</span>
        <span class="card-date">${formatTime(c.dateAdded)}</span>
      </div>`;
    // Prepend so newest is at top
    container.prepend(card);
  }
  document.getElementById('count-merged').textContent = state.merged.length;
}

function renderRejectedIncremental() {
  const container = document.getElementById('lane-rejected');
  for (let i = render.rejectedCount; i < state.rejected.length; i++) {
    const c = state.commits.get(state.rejected[i]);
    const runsTag = c.ciRuns > 1
      ? `<span class="card-runs" title="This commit ran CI ${c.ciRuns} times. It was restarted ${c.ciRuns - 1}x due to earlier failures in the queue.">⟳${c.ciRuns}</span>`
      : '';
    const card = document.createElement('div');
    card.className = 'card card--rejected card--entering';
    card.dataset.id = c.id;
    card.innerHTML = `
      <div class="card-row">
        <span class="card-dot"></span>
        <span class="card-name">${c.name}</span>
        ${runsTag}
        <span class="card-badge">✕</span>
        <span class="card-date">${formatTime(c.dateAdded)}</span>
      </div>`;
    container.prepend(card);
  }
  document.getElementById('count-rejected').textContent = state.rejected.length;
}

// ── Rendering: Progress Bars ───────────────────

function updateProgressBars() {
  const container = document.getElementById('lane-queue');
  const activeSize = Math.min(config.batchSize, state.queue.length);

  for (let i = 0; i < activeSize; i++) {
    const c = state.commits.get(state.queue[i]);
    if (c.ciStatus !== 'running') continue;

    const card = container.children[i];
    if (!card) continue;

    const fill = card.querySelector('.card-progress-fill');
    if (fill) {
      const pct = Math.min(100, (c.ciElapsed / c.ciDuration) * 100);
      fill.style.width = pct + '%';
    }

    const timeEl = card.querySelector('.card-time');
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

  const el = document.createElement('span');
  el.className = 'stat-delta';
  el.textContent = '+' + formatCITime(deltaMs);
  el.style.color = color;

  // Position relative to the stat value
  anchor.style.position = 'relative';
  anchor.appendChild(el);

  // Trigger animation on next frame
  requestAnimationFrame(() => {
    el.classList.add('stat-delta--active');
  });

  // Remove after animation
  setTimeout(() => el.remove(), 1200);
}

// ── Rendering: Stats ───────────────────────────

function formatCITime(ms) {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const s = abs / 1000;
  if (s < 60) return sign + s.toFixed(1) + ' s';
  const totalMin = s / 60;
  if (totalMin < 60) {
    const m = Math.floor(totalMin);
    const rem = Math.round(s % 60);
    return sign + (rem > 0 ? m + 'm ' + rem + 's' : m + ' m');
  }
  const h = Math.floor(totalMin / 60);
  const remMin = Math.round(totalMin % 60);
  return sign + (remMin > 0 ? h + 'h ' + remMin + 'm' : h + ' h');
}

function updateTimeStats() {
  document.getElementById('stat-wall-clock').textContent = formatCITime(state.wallClockTime);
  const saved = state.sequentialCITime - state.wallClockTime;
  document.getElementById('stat-time-saved').textContent = saved > 0 ? formatCITime(saved) : '0 s';
  updateSummaryPanel();
}

function updateStats() {
  document.getElementById('stat-queue').textContent = state.queue.length;
  document.getElementById('stat-merged').textContent = state.merged.length;
  document.getElementById('stat-rejected').textContent = state.rejected.length;
  document.getElementById('stat-reruns').textContent = state.totalReruns;
  document.getElementById('count-queue').textContent = state.queue.length;
  document.getElementById('count-merged').textContent = state.merged.length;
  document.getElementById('count-rejected').textContent = state.rejected.length;

  // CI time stats
  document.getElementById('stat-ci-useful').textContent = formatCITime(state.successCITime);
  document.getElementById('stat-ci-wasted').textContent = formatCITime(state.wastedCITime);

  const ratioEl = document.getElementById('stat-ci-ratio');
  if (state.successCITime > 0) {
    const pct = Math.round((state.wastedCITime / state.successCITime) * 100);
    ratioEl.textContent = pct + '%';
  } else if (state.wastedCITime > 0) {
    ratioEl.textContent = '∞';
  } else {
    ratioEl.textContent = '—';
  }

  // Wall clock & time saved
  updateTimeStats();

  // Percentages for merged vs rejected
  const settled = state.merged.length + state.rejected.length;
  const pctMerged = document.getElementById('pct-merged');
  const pctRejected = document.getElementById('pct-rejected');
  if (settled > 0) {
    pctMerged.textContent = Math.round((state.merged.length / settled) * 100) + '%';
    pctRejected.textContent = Math.round((state.rejected.length / settled) * 100) + '%';
  } else {
    pctMerged.textContent = '';
    pctRejected.textContent = '';
  }
}

// ── Summary Overlay ────────────────────────────

function showSummaryButton() {}
function hideSummaryButton() {}

function updateSummaryPanel() {
  const overlay = document.getElementById('summary-overlay');
  if (!overlay || overlay.hidden) return;

  const total = state.merged.length + state.rejected.length;
  const successRate = total > 0 ? Math.round((state.merged.length / total) * 100) : 0;
  const wasteRatio = state.successCITime > 0
    ? Math.round((state.wastedCITime / state.successCITime) * 100)
    : state.wastedCITime > 0 ? Infinity : 0;
  const timeSaved = state.sequentialCITime - state.wallClockTime;

  // Hero stats (top grid)
  document.getElementById('sum-hero-wall-clock').textContent = formatCITime(state.wallClockTime);
  document.getElementById('sum-hero-time-saved').textContent = timeSaved > 0 ? formatCITime(timeSaved) : '0 s';
  document.getElementById('sum-hero-waste-ratio').textContent = wasteRatio === Infinity ? '∞' : wasteRatio ? wasteRatio + '%' : '—';
  document.getElementById('sum-hero-wasted-ci').textContent = formatCITime(state.wastedCITime);

  // Queue stats rows
  document.getElementById('sum-batch').textContent = config.batchSize;
  document.getElementById('sum-processed').textContent = total;
  document.getElementById('sum-merged-cmp').textContent = state.merged.length;
  document.getElementById('sum-rejected-cmp').textContent = state.rejected.length;

  // Time rows
  document.getElementById('sum-wall-clock').textContent = formatCITime(state.wallClockTime);
  document.getElementById('sum-sequential').textContent = formatCITime(state.sequentialCITime);
  document.getElementById('sum-time-saved').textContent = timeSaved > 0 ? formatCITime(timeSaved) : '0 s';

  // CI rows
  document.getElementById('sum-useful-ci').textContent = formatCITime(state.successCITime);
  document.getElementById('sum-wasted-ci').textContent = formatCITime(state.wastedCITime);
  document.getElementById('sum-waste-ratio').textContent = wasteRatio === Infinity ? '∞' : wasteRatio ? wasteRatio + '%' : '—';

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
  const sumMachine = document.getElementById('sum-cost-machine-time');
  const sumPerRun = document.getElementById('sum-cost-per-run');
  if (sumMachine) {
    sumMachine.textContent = machineMin >= 60
      ? (machineMin / 60).toFixed(1).replace(/\.0$/, '') + ' h'
      : machineMin + ' min';
  }
  if (sumPerRun) sumPerRun.textContent = formatCost(machineMin * rate);

  document.getElementById('sum-total-cost').textContent = formatCost(totalCost);
  document.getElementById('sum-wasted-cost').textContent = formatCost(wastedCost);

  // Comparison with previous run
  const prev = state.previousRun;
  const hasCompare = !!prev;
  const colHeader = document.getElementById('summary-col-header');
  if (colHeader) colHeader.hidden = !hasCompare;

  // Toggle compare grid layout on all summary rows
  document.querySelectorAll('.summary-row').forEach(row => {
    row.classList.toggle('summary-row--compare', hasCompare);
  });

  // Helper: set prev value, diff value, and diff color
  // lowerIsBetter: true for costs/waste/time, false for time saved/useful
  function setCompare(id, currentVal, prevVal, formatter, lowerIsBetter) {
    const prevEl = document.getElementById(id + '-prev');
    const diffEl = document.getElementById(id + '-diff');
    if (!prevEl || !diffEl) return;
    if (!hasCompare) {
      prevEl.textContent = '';
      diffEl.textContent = '';
      diffEl.className = 'summary-row-diff';
      return;
    }
    prevEl.textContent = formatter(prevVal);
    const delta = currentVal - prevVal;
    if (Math.abs(delta) < 0.001) {
      diffEl.textContent = '=';
      diffEl.className = 'summary-row-diff';
    } else {
      const sign = delta > 0 ? '+' : '';
      diffEl.textContent = sign + formatter(delta);
      const isBetter = lowerIsBetter ? delta < 0 : delta > 0;
      diffEl.className = 'summary-row-diff ' + (isBetter ? 'summary-row-diff--better' : 'summary-row-diff--worse');
    }
  }

  const fmtInt = v => String(v);

  if (prev) {
    const prevTimeSaved = prev.sequentialCITime - prev.wallClockTime;
    const prevWasteRatio = prev.successCITime > 0
      ? Math.round((prev.wastedCITime / prev.successCITime) * 100) : 0;

    // Queue stats
    setCompare('sum-batch', config.batchSize, prev.batchSize, fmtInt, false);
    setCompare('sum-processed', total, prev.processed, fmtInt, false);
    setCompare('sum-merged-cmp', state.merged.length, prev.merged, fmtInt, false);
    setCompare('sum-rejected-cmp', state.rejected.length, prev.rejected, fmtInt, true);

    // Time
    setCompare('sum-wall-clock', state.wallClockTime, prev.wallClockTime, formatCITime, true);
    setCompare('sum-sequential', state.sequentialCITime, prev.sequentialCITime, formatCITime, true);
    setCompare('sum-time-saved', Math.max(0, timeSaved), Math.max(0, prevTimeSaved), formatCITime, false);
    setCompare('sum-useful-ci', state.successCITime, prev.successCITime, formatCITime, false);
    setCompare('sum-wasted-ci', state.wastedCITime, prev.wastedCITime, formatCITime, true);
    setCompare('sum-waste-ratio', wasteRatio === Infinity ? 999 : wasteRatio, prevWasteRatio, v => v + '%', true);
    setCompare('sum-total-cost', totalCost, prev.totalCost, formatCost, true);
    setCompare('sum-wasted-cost', wastedCost, prev.wastedCost, formatCost, true);
  } else {
    // Clear all prev/diff fields
    ['sum-batch', 'sum-processed', 'sum-merged-cmp', 'sum-rejected-cmp',
     'sum-wall-clock', 'sum-sequential', 'sum-time-saved', 'sum-useful-ci',
     'sum-wasted-ci', 'sum-waste-ratio', 'sum-total-cost', 'sum-wasted-cost'].forEach(id => {
      setCompare(id, 0, 0, () => '', true);
    });
  }
}

function showSummary() {
  const overlay = document.getElementById('summary-overlay');
  if (!overlay) return;
  const title = document.getElementById('summary-title');
  if (title) {
    title.textContent = state.queue.length === 0 ? 'Simulation Complete' : 'Simulation Summary';
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
  const overlay = document.getElementById('summary-overlay');
  if (overlay) overlay.hidden = true;
}

function initSummary() {
  const closeBtn = document.getElementById('summary-close');
  const resetBtn = document.getElementById('summary-reset');
  const startBtn = document.getElementById('summary-start');
  const pauseBtn = document.getElementById('summary-pause');
  const overlay = document.getElementById('summary-overlay');
  const openBtn = document.getElementById('btn-summary');

  const instantBtn = document.getElementById('summary-instant');

  if (closeBtn) closeBtn.addEventListener('click', hideSummary);
  if (startBtn) startBtn.addEventListener('click', doStart);
  if (pauseBtn) pauseBtn.addEventListener('click', doPause);
  if (resetBtn) resetBtn.addEventListener('click', () => {
    hideSummary();
    doReset();
  });
  if (instantBtn) instantBtn.addEventListener('click', () => {
    // Keep overlay open and suppress animations for in-place re-run
    state._keepSummaryOpen = true;
    doReset();
    runInstant();
    state._keepSummaryOpen = false;
  });
  if (openBtn) openBtn.addEventListener('click', showSummary);
  // Close on backdrop click
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideSummary();
  });

  // Update summary when cost inputs change
  const sumRate = document.getElementById('sum-cost-rate');
  const sumRunners = document.getElementById('sum-cost-runners');
  if (sumRate) sumRate.addEventListener('input', updateSummaryPanel);
  if (sumRunners) sumRunners.addEventListener('input', updateSummaryPanel);
}

// ── Cost Helpers ────────────────────────────────

function formatCost(dollars) {
  if (dollars < 0.01 && dollars > 0) return '< $0.01';
  if (dollars >= 1000) return '$' + dollars.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (dollars >= 100) return '$' + dollars.toFixed(0);
  if (dollars >= 10) return '$' + dollars.toFixed(1);
  return '$' + dollars.toFixed(2);
}

function getCostRate() {
  const input = document.getElementById('sum-cost-rate');
  if (!input) return 0;
  const val = parseFloat(input.value);
  return isNaN(val) || val < 0 ? 0 : val;
}

function getCostRunners() {
  const input = document.getElementById('sum-cost-runners');
  if (!input) return 1;
  const val = parseInt(input.value, 10);
  return isNaN(val) || val < 1 ? 1 : val;
}

// ── Sidebar Bindings ───────────────────────────

function readConfigFromUI() {
  config.successRate  = +document.getElementById('cfg-success-rate').value;
  config.batchSize    = +document.getElementById('cfg-batch-size').value;
  config.totalCommits = +document.getElementById('cfg-total-commits').value;
  config.ciDuration   = +document.getElementById('cfg-ci-duration').value;
  config.ciJitter     = +document.getElementById('cfg-ci-jitter').value;
  config.speed        = +document.getElementById('cfg-speed').value;
}

function getOptimalBatch() {
  const p = config.successRate / 100;
  if (p >= 1) return 50;   // 100% success → max parallelism
  if (p <= 0) return 1;    // 0% success → no point batching
  return Math.max(1, Math.min(50, Math.round(1 / (1 - p))));
}

// ── Optimal Chart ──────────────────────────────

function renderOptimalChart() {
  const canvas = document.getElementById('optimal-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Handle high-DPI displays
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const pad = { top: 8, right: 8, bottom: 8, left: 8 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const p = config.successRate / 100;
  const maxBatch = 50;

  // Compute data series
  const throughput = [];
  const cost = [];
  for (let b = 1; b <= maxBatch; b++) {
    const pb = Math.pow(p, b);
    throughput.push(b * pb);                              // expected merges per cycle

    // Cost per merged commit: b / E[merged per cycle]
    // E[merged] = sum_{k=0}^{b-1} k * p^k * (1-p)  +  b * p^b
    // At p=1 this equals b, so cost = 1 (flat line). ✓
    let em = 0;
    for (let k = 0; k < b; k++) em += k * Math.pow(p, k) * (1 - p);
    em += b * pb;
    cost.push(em > 0.0001 ? b / em : b * 100);
  }

  // Normalize each series to 0-1 (linear scale for both)
  const maxT = Math.max(...throughput, 0.001);
  const normT = throughput.map(v => v / maxT);
  // Ensure flat lines (e.g. 100% success) sit at mid-height, not the top
  const maxC = Math.max(...cost, cost[0] * 2, 0.001);
  const normC = cost.map(v => v / maxC);

  // Read CSS colors
  const styles = getComputedStyle(document.documentElement);
  const colBlue = styles.getPropertyValue('--blue').trim() || '#388bfd';
  const colRed = styles.getPropertyValue('--red').trim() || '#f85149';
  const colBorder = styles.getPropertyValue('--border').trim() || '#30363d';
  const colMuted = styles.getPropertyValue('--text-muted').trim() || '#484f58';
  const colBg = styles.getPropertyValue('--bg-card').trim() || '#1c2128';

  // Clear and fill background
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = colBg;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 6);
  ctx.fill();

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

  // Helper: batch index to x
  function bx(b) {
    return pad.left + ((b - 1) / (maxBatch - 1)) * plotW;
  }
  // Helper: normalized value to y (0 = bottom, 1 = top)
  function by(v) {
    return pad.top + plotH * (1 - v);
  }

  // Draw a line series
  function drawLine(data, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = bx(i + 1);
      const y = by(data[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Draw throughput line (blue)
  drawLine(normT, colBlue);

  // Draw cost line (red)
  drawLine(normC, colRed);

  // Optimal batch vertical dashed line
  const optimal = getOptimalBatch();
  const optX = bx(optimal);
  ctx.strokeStyle = colMuted;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(optX, pad.top);
  ctx.lineTo(optX, pad.top + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  // Current batch size vertical solid line + dots
  const current = config.batchSize;
  const curX = bx(current);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(curX, pad.top);
  ctx.lineTo(curX, pad.top + plotH);
  ctx.stroke();

  // Dot on throughput line at current batch
  const curTY = by(normT[current - 1] || 0);
  ctx.fillStyle = colBlue;
  ctx.beginPath();
  ctx.arc(curX, curTY, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Dot on cost line at current batch
  const curCY = by(normC[current - 1] || 0);
  ctx.fillStyle = colRed;
  ctx.beginPath();
  ctx.arc(curX, curCY, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Batch number label at current position
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '9px ' + (styles.getPropertyValue('--font-mono').trim() || 'monospace');
  ctx.textAlign = 'center';
  ctx.fillText(current, curX, pad.top + plotH + pad.bottom);
}

function initOptimalChart() {
  const canvas = document.getElementById('optimal-chart');
  if (!canvas) return;

  const tooltip = document.getElementById('optimal-chart-tooltip');

  function batchFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const pad = 8;
    const plotW = rect.width - pad * 2;
    const relX = e.clientX - rect.left - pad;
    const ratio = Math.max(0, Math.min(1, relX / plotW));
    return Math.round(ratio * 49) + 1; // 1-50
  }

  canvas.addEventListener('click', (e) => {
    const batch = batchFromEvent(e);
    document.getElementById('cfg-batch-size').value = batch;
    readConfigFromUI();
    syncUIValues();
    if (!state.isRunning) doReset();
  });

  canvas.addEventListener('mousemove', (e) => {
    const batch = batchFromEvent(e);
    const rect = canvas.getBoundingClientRect();
    const wrapRect = canvas.parentElement.getBoundingClientRect();
    const relX = e.clientX - wrapRect.left;
    const relY = e.clientY - wrapRect.top;
    tooltip.textContent = 'Batch ' + batch;
    // Clamp X so tooltip stays within the chart wrapper
    const tw = tooltip.offsetWidth;
    const clampedX = Math.max(tw / 2 + 2, Math.min(relX, wrapRect.width - tw / 2 - 2));
    tooltip.style.left = clampedX + 'px';
    tooltip.style.top = (relY - 28) + 'px';
    tooltip.style.transform = 'translateX(-50%)';
    tooltip.hidden = false;
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.hidden = true;
  });

  // Initial render
  renderOptimalChart();
}

function syncUIValues() {
  document.getElementById('val-success-rate').textContent = config.successRate + '%';
  document.getElementById('val-batch-size').textContent = config.batchSize;
  document.getElementById('val-total-commits').textContent = config.totalCommits;
  document.getElementById('val-ci-duration').textContent = config.ciDuration + ' m';
  document.getElementById('val-ci-jitter').textContent = '± ' + config.ciJitter + ' m';
  document.getElementById('val-speed').textContent = config.speed + '×';
  document.getElementById('val-optimal-batch').textContent = getOptimalBatch();
  renderOptimalChart();
}

function writeConfigToUI() {
  document.getElementById('cfg-success-rate').value = config.successRate;
  document.getElementById('cfg-batch-size').value = config.batchSize;
  document.getElementById('cfg-total-commits').value = config.totalCommits;
  document.getElementById('cfg-ci-duration').value = config.ciDuration;
  document.getElementById('cfg-ci-jitter').value = config.ciJitter;
  document.getElementById('cfg-speed').value = config.speed;
  syncUIValues();
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  config.successRate = p.successRate;
  config.batchSize = p.batchSize;
  config.totalCommits = p.totalCommits;
  config.ciDuration = p.ciDuration;
  config.ciJitter = p.ciJitter;
  config.speed = p.speed;
  writeConfigToUI();
  doReset();
}

// ── Event Binding ──────────────────────────────

function bindEvents() {
  // Simulation controls
  document.getElementById('btn-start').addEventListener('click', doStart);
  document.getElementById('btn-pause').addEventListener('click', doPause);
  document.getElementById('btn-reset').addEventListener('click', doReset);

  // Step mode
  document.getElementById('cfg-step-mode').addEventListener('change', (e) => {
    config.stepMode = e.target.checked;
    document.getElementById('val-step-mode').textContent = config.stepMode ? 'On' : 'Off';
    // If step mode is turned off while waiting, execute the pending evaluation instantly
    if (!config.stepMode && state.stepWaiting && !state.animating) {
      hideStepBanner();
      state.stepWaiting = false;
      evaluateQueue();
      lastTimestamp = 0;
    }
  });
  document.getElementById('btn-step-continue').addEventListener('click', doStepContinue);

  // Instant mode button
  document.getElementById('btn-instant').addEventListener('click', () => {
    // Reset first if a simulation already ran, then run instantly
    if (state.isRunning || state.merged.length > 0 || state.rejected.length > 0) {
      doReset();
    }
    runInstant();
  });

  // Optimal batch size button
  document.getElementById('btn-optimal-batch').addEventListener('click', () => {
    const optimal = getOptimalBatch();
    document.getElementById('cfg-batch-size').value = optimal;
    readConfigFromUI();
    syncUIValues();
    if (!state.isRunning) doReset();
  });

  // Sidebar sliders — live update labels; some require reset
  const liveSliders = ['cfg-success-rate', 'cfg-speed'];
  const resetSliders = ['cfg-batch-size', 'cfg-total-commits', 'cfg-ci-duration', 'cfg-ci-jitter'];

  liveSliders.forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      readConfigFromUI();
      syncUIValues();
    });
  });

  resetSliders.forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      readConfigFromUI();
      syncUIValues();
      // If not running, auto-apply by resetting
      if (!state.isRunning) {
        doReset();
      }
    });
  });

  // Presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyPreset(btn.dataset.preset);
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    // Don't handle shortcuts while welcome dialog is open
    const welcome = document.getElementById('welcome-overlay');
    if (welcome && !welcome.hidden) return;
    if (e.code === 'Space') { e.preventDefault(); state.stepWaiting ? doStepContinue() : (!state.isRunning || state.isPaused ? doStart() : doPause()); }
    if (e.code === 'Enter' && state.stepWaiting) { e.preventDefault(); doStepContinue(); }
    if (e.code === 'KeyR')  { doReset(); }
  });
}

// ── Welcome Dialog ─────────────────────────────

const WELCOME_KEY = 'ghmq-welcome-seen';

const welcome = {
  overlay: null,
  steps: null,
  dots: null,
  nextBtn: null,
  currentStep: 0,
  totalSteps: 4,
};

function openWelcome() {
  const w = welcome;
  w.currentStep = 0;
  // Reset all steps to initial state
  w.steps.forEach((s, i) => { s.hidden = i !== 0; });
  w.dots.forEach((d, i) => {
    d.classList.toggle('welcome-dot-btn--active', i === 0);
  });
  w.nextBtn.textContent = 'Next →';
  w.overlay.hidden = false;
  // Re-trigger entrance animation
  w.overlay.classList.remove('welcome-overlay--closing');
  w.overlay.style.animation = 'none';
  void w.overlay.offsetWidth;
  w.overlay.style.animation = '';
}

function closeWelcome() {
  localStorage.setItem(WELCOME_KEY, '1');
  welcome.overlay.classList.add('welcome-overlay--closing');
  setTimeout(() => {
    welcome.overlay.hidden = true;
    welcome.overlay.classList.remove('welcome-overlay--closing');
  }, 300);
}

function welcomeGoToStep(idx) {
  const w = welcome;
  if (idx < 0 || idx >= w.totalSteps) return;
  w.steps[w.currentStep].hidden = true;
  w.currentStep = idx;
  w.steps[w.currentStep].hidden = false;
  // Re-trigger animation
  w.steps[w.currentStep].style.animation = 'none';
  void w.steps[w.currentStep].offsetWidth;
  w.steps[w.currentStep].style.animation = '';

  w.dots.forEach((d, i) => {
    d.classList.toggle('welcome-dot-btn--active', i === w.currentStep);
  });

  if (w.currentStep === w.totalSteps - 1) {
    w.nextBtn.textContent = 'Get Started →';
  } else {
    w.nextBtn.textContent = 'Next →';
  }
}

function initGlossary() {
  const overlay = document.getElementById('glossary-overlay');
  const closeBtn = document.getElementById('glossary-close');
  const openBtn = document.getElementById('btn-glossary');
  if (!overlay) return;

  function showGlossary() {
    overlay.hidden = false;
  }
  function hideGlossary() {
    overlay.hidden = true;
  }

  if (openBtn) openBtn.addEventListener('click', showGlossary);
  if (closeBtn) closeBtn.addEventListener('click', hideGlossary);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideGlossary();
  });
}

function initWelcome() {
  const overlay = document.getElementById('welcome-overlay');
  if (!overlay) return;

  welcome.overlay = overlay;
  welcome.steps = overlay.querySelectorAll('.welcome-step');
  welcome.dots = overlay.querySelectorAll('.welcome-dot-btn');
  welcome.nextBtn = document.getElementById('welcome-next');
  const skipBtn = document.getElementById('welcome-skip');

  // If already seen, hide immediately
  if (localStorage.getItem(WELCOME_KEY)) {
    overlay.hidden = true;
  }

  welcome.nextBtn.addEventListener('click', () => {
    if (welcome.currentStep < welcome.totalSteps - 1) {
      welcomeGoToStep(welcome.currentStep + 1);
    } else {
      closeWelcome();
    }
  });

  skipBtn.addEventListener('click', closeWelcome);

  welcome.dots.forEach(dot => {
    dot.addEventListener('click', () => {
      welcomeGoToStep(+dot.dataset.dot);
    });
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowRight' || e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (welcome.currentStep < welcome.totalSteps - 1) {
        welcomeGoToStep(welcome.currentStep + 1);
      } else {
        closeWelcome();
      }
    }
    if (e.code === 'ArrowLeft' && welcome.currentStep > 0) {
      e.preventDefault();
      welcomeGoToStep(welcome.currentStep - 1);
    }
    if (e.code === 'Escape') {
      closeWelcome();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeWelcome();
  });

  // Help button in sidebar
  document.getElementById('btn-help').addEventListener('click', () => {
    localStorage.removeItem(WELCOME_KEY);
    openWelcome();
  });
}

// ── Initialize ─────────────────────────────────

function init() {
  bindEvents();
  initSummary();
  initGlossary();
  initOptimalChart();
  doReset();
  initWelcome();
}

document.addEventListener('DOMContentLoaded', init);
