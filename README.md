# Merge Queue Simulator

An interactive, single-page simulator for experimenting with GitHub merge queue behavior.

GitHub's merge queue batches pull requests and tests them together before merging into `main`. This saves time by running CI in parallel, but when a commit fails, the remaining batch restarts. A low CI success rate with a large batch size can waste significant CI time.

This simulator lets you tweak configuration and watch how that plays out in real time.

## How it works

Commits enter a FIFO queue. The first N (the "batch size") run CI simultaneously with randomized durations. Once CI finishes, the queue evaluates from the head:

1. Consecutive successes from the head are merged together.
2. If the head fails, it is rejected and all remaining active commits restart CI, wasting their progress.
3. New commits fill the active window and the cycle repeats.

Three lanes show the current state: **Queue** (active and waiting), **Rejected** (failed), and **Merged** (successful).

## Controls

Use the sidebar to configure:

- **CI Success Rate** -- probability each commit's CI passes
- **Batch Size** -- how many commits run CI in parallel
- **Total Commits** -- number of commits to simulate
- **CI Duration / Jitter** -- average CI time and variance
- **Speed** -- simulation speed multiplier
- **Step Mode** -- pause before each merge or reject so you can follow along

Presets are available for common scenarios. The stats bar tracks useful vs. wasted CI time, wall clock, and time saved compared to running commits sequentially.

Keyboard shortcuts: `Space` to start/pause/continue, `R` to reset.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
