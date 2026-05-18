# pi-extension-smart-edit

A [pi](https://github.com/badlogic/pi) extension that overrides the built-in `edit` tool with whitespace-tolerant matching, designed for local/quantized LLMs.

**smart-edit is a drop-in replacement for `edit` that makes local/quantized LLM coding more reliable.**

## TL;DR

With Qwen 3.6 int4 runs (10 vs 10), smart-edit improved **edit success from 46% to 89%** and **task pass from 40% to 80%** on my local benchmark\*.

It also reduced average runtime from **707s to 492s** (**~30% faster**) on that benchmark set.

For Qwen 3.6 nvfp4, the latest patched run improved task pass (10% → 20%) but has lower edit success and slower runtime by far in my use case (see table).

---

## Problem

Local LLMs often fail exact-text edits because of tiny formatting drift (indentation, quotes, trailing spaces). This causes retry loops and wasted tokens.

## Solution

`smart-edit` keeps `edit` precise, but more tolerant for local models:

1. Exact match (same behavior as built-in)
2. Normalized line match (whitespace/quote tolerant)

So you keep strict edits, but avoid brittle failures from tiny formatting drift.

It supports the current `edit` contract and keeps compatibility with older argument shapes, so resumed sessions continue to work.

## Install

```bash
pi install /path/to/pi-extension-smart-edit
```

Or for quick local testing:

```bash
pi -e /path/to/pi-extension-smart-edit/src/index.ts
```

## Usage

After loading the extension, use `edit` normally in pi. The model/tooling handles the argument shape automatically.

## Benchmark summary

This benchmark runs the same medium coding task 10 times per model, then reports:

- `edit` success rate,
- end-to-end task pass rate (typecheck + tests + no timeout),
- runtime.

### Results

| Model          | Edit Success (without) | Edit Success (with) | Task Pass (without) | Task Pass (with) | Avg Time (without) | Avg Time (with) |
| -------------- | ---------------------: | ------------------: | ------------------: | ---------------: | -----------------: | --------------: |
| Qwen 3.5 int4  |                    69% |                 90% |                 20% |              40% |               620s |            655s |
| Qwen 3.5 nvfp4 |                    98% |                 86% |                 20% |              20% |               651s |            814s |
| Qwen 3.6 int4  |                    46% |              89% 🔥 |                 40% |           80% 🔥 |               707s |         492s 🔥 |
| Qwen 3.6 nvfp4 |                    74% |                 72% |                 10% |              20% |               706s |            839s |

- Benchmark code isn't shared. I may do it later once I open source the other repo that I'm developing with only local LLMs
