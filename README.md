# pi-model-router

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that runs every
request on a **cheap** model and escalates to a **capable** one *during the run*
when the work turns out to need it.

Two escalation mechanisms, selectable with `escalation.mode`:

| mode | how escalation happens |
|---|---|
| `tool` | the cheap model gets an `escalate` tool it can call when the task is beyond it |
| `encoder` | after each turn, a small encoder model ([convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya)) reads a compact summary of the run so far and predicts whether the cheap model will fail |
| `both` (default) | either path can escalate |

Escalation switches the model for the rest of the run — pi picks the new model up
on the next turn — and optionally keeps the capable model for the next N requests
(`escalation.stickyCapableRequests`).

## Why escalation instead of routing up front

Routing on the prompt alone has a low ceiling: the prompt does not reveal whether
a task is a one-line edit or a multi-module refactor, and the pair-specific
failure of a cheap model is largely not a property of the prompt text. The
trajectory does contain that information — commands that fail, errors that
repeat, an agent going in circles — so this extension defers the decision until
there is something to observe.

Measured honestly (see the companion `router-eval` harness): the encoder signal is
**weak** on public benchmarks (AUC ≈ 0.5 on RouterBench and Terminal-Bench
trajectories), so treat `encoder` mode as experimental and prefer `both` — the
`escalate` tool is the reliable path, because the model itself knows when it is
out of its depth. The encoder costs ~35 ms per check against a local server and
never blocks the run (failures are ignored).

## Install

```bash
pi install git:github.com/NathanHB/pi-model-router
```

Or try without installing: `pi -e git:github.com/NathanHB/pi-model-router`

## Configure

```bash
mkdir -p ~/.pi/agent
cp config/model-router.example.json ~/.pi/agent/model-router.json
```

```json
{
  "cheap":   [{ "provider": "anthropic", "model": "claude-haiku-4-5", "thinkingLevel": "off" }],
  "capable": [{ "provider": "anthropic", "model": "claude-sonnet-5",  "thinkingLevel": "high" }],
  "escalation": { "mode": "both" }
}
```

| key | default | meaning |
|---|---|---|
| `cheap` / `capable` | `[]` | ordered candidate lists; the first with working auth is used |
| `escalation.mode` | `"both"` | `tool`, `encoder`, or `both` |
| `escalation.tool.promptHint` | `true` | append a one-line hint to the system prompt telling the model the tool exists |
| `escalation.encoder.url` | `http://127.0.0.1:9731` | `laya-serve` base URL |
| `escalation.encoder.threshold` | `0.75` | escalate when P(cheap fails) ≥ this |
| `escalation.encoder.minConfidence` | `0.4` | never escalate on a less confident answer |
| `escalation.encoder.checkEvery` / `maxChecks` | `1` / `8` | check cadence and cap |
| `escalation.encoder.instructions` | built-in | the statement laya scores |
| `escalation.stickyCapableRequests` | `0` | after an escalated run, start the next N requests capable |
| `imagesForceCapable` | `true` | image attachments skip the cheap model |
| `excludeProviders` | `[]` | providers hidden from the `/router cheap`/`capable` pickers (e.g. `"anthropic"` while its auth is broken) |
| `bigPrefix` / `smallPrefix` | `!big` / `!small` | one-shot start-tier pins |
| `notify` | `true` | notify on escalation |

### Encoder server

```bash
pip install "laya[serve]" && laya-serve     # or scripts/start-laya.sh
```

The first request downloads the checkpoint (~850 MB). Without the server the
extension simply skips encoder checks.

## Commands

| input | effect |
|---|---|
| `/router` | status: tiers, mode, current run's turns/checks, whether it escalated |
| `/router cheap` | pick the cheap-tier model from a list (or `/router cheap provider/model` to set it directly) — saved to the config file |
| `/router capable` | same for the capable tier |
| `/router on` / `off` | enable / disable |
| `/router auto` | resume after a manual model pick |
| `/router tool` / `encoder` / `both` | switch escalation mode at runtime |
| `/router big` / `small` | start the next request on that tier (one-shot) |
| `!big <msg>` / `!small <msg>` | same, inline |

`/router cheap` and `/router capable` only offer models that have working auth, and
write to the project config (`.pi/model-router.json`) when one exists — since that
file wins per-key — otherwise to `~/.pi/agent/model-router.json`. The choice takes
effect on the next request; no reload needed.

Picking a model yourself (`/model`, Ctrl+P) pauses auto-routing; `/router auto`
resumes.

## Notes

- `pi.setModel` persists the selected model as pi's default and appends a
  model-change entry to the session — escalation therefore leaves the session on
  the capable model until the next request resets it to cheap.
- The encoder sees only the run so far (tool names/inputs, failure count,
  repetition, last output tail, first 260 chars of the task) — not the full
  conversation.
- If the capable tier is unavailable (no auth), escalation reports it and the
  cheap model continues.
