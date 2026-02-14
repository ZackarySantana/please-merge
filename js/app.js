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
    ciMin: 1,
    ciMax: 4,
    speed: 2,
    label: 'Mostly Green',
  },
  'flaky-ci': {
    successRate: 50,
    batchSize: 10,
    totalCommits: 100,
    ciMin: 2,
    ciMax: 8,
    speed: 3,
    label: 'Flaky CI',
  },
  'disaster': {
    successRate: 15,
    batchSize: 10,
    totalCommits: 60,
    ciMin: 1,
    ciMax: 6,
    speed: 4,
    label: 'Disaster Mode',
  },
  'fast-and-furious': {
    successRate: 80,
    batchSize: 20,
    totalCommits: 200,
    ciMin: 1,
    ciMax: 3,
    speed: 8,
    label: 'Fast & Furious',
  },
};

// ── Configuration ──────────────────────────────

const config = {
  successRate: 70,
  batchSize: 10,
  totalCommits: 100,
  ciMin: 1,    // seconds
  ciMax: 10,   // seconds
  speed: 1,
  stepMode: true,
};

// ── State ──────────────────────────────────────

const state = {
  commits: new Map(),   // id → commit object
  queue: [],            // ordered ids: [0]=oldest (HEAD)
  merged: [],           // ids, newest push()ed last
  rejected: [],         // ids, newest push()ed last
  totalReruns: 0,       // total duplicate CI runs across all commits
  isRunning: false,
  isPaused: false,
  stepWaiting: false,   // true when step mode has paused before evaluation
  animating: false,     // true during step-mode transition animation
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
    });
    queue.push(id);
  }
  return { commits, queue };
}

// ── Helpers ────────────────────────────────────

function rand(min, max) {
  return min + Math.random() * (max - min);
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
  const minMs = config.ciMin * 1000;
  const maxMs = config.ciMax * 1000;
  commit.ciStatus = 'running';
  commit.ciElapsed = 0;
  commit.ciDuration = rand(minMs, maxMs);
  commit.ciOutcome = Math.random() * 100 < config.successRate ? 'success' : 'fail';
  commit.ciRuns++;
  if (commit.ciRuns > 1) {
    state.totalReruns++;
  }
}

function restartActiveWindow() {
  const size = Math.min(config.batchSize, state.queue.length);
  for (let i = 0; i < size; i++) {
    const c = state.commits.get(state.queue[i]);
    c.ciStatus = 'idle';
    c.ciElapsed = 0;
    c.ciDuration = 0;
    c.ciOutcome = null;
  }
}

function update(dt) {
  if (state.queue.length === 0) {
    state.isRunning = false;
    updateButtons();
    return;
  }

  // If step mode is waiting for user or animating, freeze everything
  if (state.stepWaiting || state.animating) return;

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

    // Check if the head is ready for evaluation
    const head = state.commits.get(state.queue[0]);
    const headReady = head && (head.ciStatus === 'success' || head.ciStatus === 'fail');

    if (config.stepMode && headReady) {
      state.stepWaiting = true;
      showStepBanner();
      return;
    }

    evaluateQueue();
  }
}

function evaluateQueue() {
  let moved = false;

  while (state.queue.length > 0) {
    const id = state.queue[0];
    const c = state.commits.get(id);

    if (c.ciStatus === 'success') {
      state.queue.shift();
      state.merged.push(id);
      moved = true;
      continue;
    }

    if (c.ciStatus === 'fail') {
      state.queue.shift();
      state.rejected.push(id);
      moved = true;
      // Restart remaining active window
      restartActiveWindow();
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
function evaluateQueueStep() {
  let moved = false;

  // First: try to merge all consecutive successes from the head
  while (state.queue.length > 0) {
    const c = state.commits.get(state.queue[0]);
    if (c.ciStatus === 'success') {
      state.queue.shift();
      state.merged.push(c.id);
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
      state.rejected.push(c.id);
      moved = true;
      restartActiveWindow();
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
}

// ── Step Mode ──────────────────────────────────

function previewEvaluation() {
  // Scan the head of the queue to describe what will happen
  if (state.queue.length === 0) return { action: 'none' };

  const head = state.commits.get(state.queue[0]);
  if (head.ciStatus === 'fail') {
    return {
      action: 'reject',
      commit: head,
      description: `Reject "${head.name}" — CI failed. Remaining active window will restart CI.`,
    };
  }

  if (head.ciStatus === 'success') {
    // Count consecutive successes from head
    let count = 0;
    for (let i = 0; i < state.queue.length; i++) {
      const c = state.commits.get(state.queue[i]);
      if (c.ciStatus === 'success') {
        count++;
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
  } else if (preview.action === 'reject') {
    icon.textContent = '✕';
    icon.className = 'step-banner-icon step-banner-icon--reject';
    title.textContent = 'Head commit failed — reject & restart';
    title.style.color = 'var(--red)';
  }

  desc.textContent = preview.description;
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

      // Check if the new head is also ready — if so, pause again
      if (state.queue.length > 0) {
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

  animFrameId = requestAnimationFrame(loop);
}

// ── Controls ───────────────────────────────────

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
  // Clean up any in-flight animation clones
  document.querySelectorAll('.card-clone-flying').forEach(el => el.remove());
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  lastTimestamp = 0;

  const { commits, queue } = generateCommits(config.totalCommits);
  state.commits = commits;
  state.queue = queue;
  state.merged = [];
  state.rejected = [];
  state.totalReruns = 0;

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

  if (state.isRunning && !state.isPaused) {
    startBtn.disabled = true;
    pauseBtn.disabled = false;
  } else if (state.isRunning && state.isPaused) {
    startBtn.disabled = false;
    startBtn.querySelector('.btn-icon').textContent = '▶';
    startBtn.lastChild.textContent = ' Resume';
    pauseBtn.disabled = true;
  } else {
    startBtn.disabled = state.queue.length === 0;
    startBtn.querySelector('.btn-icon').textContent = '▶';
    startBtn.lastChild.textContent = ' Start';
    pauseBtn.disabled = true;
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
  const elapsed = (commit.ciElapsed / 1000).toFixed(1);
  const total = (commit.ciDuration / 1000).toFixed(1);
  const pct = commit.ciDuration > 0 ? Math.min(100, (commit.ciElapsed / commit.ciDuration) * 100) : 0;

  let badge = '';
  let timeStr = '';

  if (commit.ciStatus === 'running') {
    timeStr = `<span class="card-time">${elapsed}/${total}s</span>`;
  } else if (commit.ciStatus === 'success') {
    badge = '<span class="card-badge">✓</span>';
    timeStr = `<span class="card-time">${total}s</span>`;
  } else if (commit.ciStatus === 'fail') {
    badge = '<span class="card-badge">✕</span>';
    timeStr = `<span class="card-time">${total}s</span>`;
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
      const elapsed = (c.ciElapsed / 1000).toFixed(1);
      const total = (c.ciDuration / 1000).toFixed(1);
      timeEl.textContent = `${elapsed}/${total}s`;
    }
  }
}

// ── Rendering: Stats ───────────────────────────

function updateStats() {
  document.getElementById('stat-queue').textContent = state.queue.length;
  document.getElementById('stat-merged').textContent = state.merged.length;
  document.getElementById('stat-rejected').textContent = state.rejected.length;
  document.getElementById('stat-reruns').textContent = state.totalReruns;
  document.getElementById('count-queue').textContent = state.queue.length;
  document.getElementById('count-merged').textContent = state.merged.length;
  document.getElementById('count-rejected').textContent = state.rejected.length;

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

// ── Sidebar Bindings ───────────────────────────

function readConfigFromUI() {
  config.successRate = +document.getElementById('cfg-success-rate').value;
  config.batchSize   = +document.getElementById('cfg-batch-size').value;
  config.totalCommits= +document.getElementById('cfg-total-commits').value;
  config.ciMin       = +document.getElementById('cfg-ci-min').value;
  config.ciMax       = +document.getElementById('cfg-ci-max').value;
  config.speed       = +document.getElementById('cfg-speed').value;

  // Enforce ciMin <= ciMax
  if (config.ciMin > config.ciMax) {
    config.ciMax = config.ciMin;
    document.getElementById('cfg-ci-max').value = config.ciMax;
  }
}

function syncUIValues() {
  document.getElementById('val-success-rate').textContent = config.successRate + '%';
  document.getElementById('val-batch-size').textContent = config.batchSize;
  document.getElementById('val-total-commits').textContent = config.totalCommits;
  document.getElementById('val-ci-min').textContent = config.ciMin + ' s';
  document.getElementById('val-ci-max').textContent = config.ciMax + ' s';
  document.getElementById('val-speed').textContent = config.speed + '×';
}

function writeConfigToUI() {
  document.getElementById('cfg-success-rate').value = config.successRate;
  document.getElementById('cfg-batch-size').value = config.batchSize;
  document.getElementById('cfg-total-commits').value = config.totalCommits;
  document.getElementById('cfg-ci-min').value = config.ciMin;
  document.getElementById('cfg-ci-max').value = config.ciMax;
  document.getElementById('cfg-speed').value = config.speed;
  syncUIValues();
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  config.successRate = p.successRate;
  config.batchSize = p.batchSize;
  config.totalCommits = p.totalCommits;
  config.ciMin = p.ciMin;
  config.ciMax = p.ciMax;
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
  });
  document.getElementById('btn-step-continue').addEventListener('click', doStepContinue);

  // Sidebar sliders — live update labels; some require reset
  const liveSliders = ['cfg-success-rate', 'cfg-speed'];
  const resetSliders = ['cfg-batch-size', 'cfg-total-commits', 'cfg-ci-min', 'cfg-ci-max'];

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
    if (e.code === 'Space') { e.preventDefault(); state.stepWaiting ? doStepContinue() : (state.isPaused ? doStart() : doPause()); }
    if (e.code === 'Enter' && state.stepWaiting) { e.preventDefault(); doStepContinue(); }
    if (e.code === 'KeyR')  { doReset(); }
  });
}

// ── Initialize ─────────────────────────────────

function init() {
  bindEvents();
  doReset();
}

document.addEventListener('DOMContentLoaded', init);
