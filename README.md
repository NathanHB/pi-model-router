# pi-model-router

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that routes
**each request** to a cheap or a capable model. The routing decision is made by
[convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya) — a 421M
non-autoregressive decision model that classifies the prompt in a single forward
pass (~35 ms) and returns a calibrated probability. It never generates text, so
there is nothing to parse and nothing to hallucinate.

If the decision server is unreachable, the router falls back to keyword/length
heuristics. The router is deliberately **cheap-biased**: routine work —
questions, lookups (email, notifications, issues, docs), summaries, and small
single-file edits — is never escalated, and an uncertain decision goes to the
cheap model rather than the capable one.

> **Measured baseline** (RouterBench, 9,000 prompts): the decision model's score
> carries no ranking signal on out-of-domain prompts (AUC 0.53), so treat the
> laya decision as experimental — the heuristics and the explicit `!big` /
> `!small` markers are the reliable parts. See the companion repo
> [router-eval](https://github.com/NathanHB/router-eval) for the evaluation
> harness.

## How routing works

For every user prompt (in `before_agent_start`, before the request is sent):

1. **One-shot pin** — `!big <msg>` / `!small <msg>` (or `/router big` then your
   message) forces a tier for one request.
2. **Sticky** — if `stickyCapableRequests > 0`, a capable request keeps the
   capable model for N follow-up requests.
3. **Laya decision** — the prompt (plus image count and length) is POSTed to
   `laya-serve` at `/v1/systemone` as a `score` question with three capability
   levels. The request gets the **capable** tier only when the **normalized
   score ≥ `capableThreshold`** (default `0.6`). If the answer's calibrated
   confidence is below `minConfidence`, the request goes **cheap** — ambiguity
   never escalates.
4. **Heuristic fallback** (server unreachable) — images, `promptLengthThreshold`,
   keyword lists, then `defaultTier`.

The first model in the tier list that exists in your registry *and* has working
auth is used (`pi.setModel` returns `false` otherwise and the next candidate is
tried).

The router pauses automatically when you pick a model yourself (`/model`,
Ctrl+P) — your choice wins. Run `/router auto` to resume auto-routing.

## Install

```bash
pi install git:github.com/NathanHB/pi-model-router
```

Or try it without installing:

```bash
pi -e git:github.com/NathanHB/pi-model-router
```

### 1. Configure models

Copy the example to the global config location (project-local
`.pi/model-router.json` overrides it per-key):

```bash
mkdir -p ~/.pi/agent
cp config/model-router.example.json ~/.pi/agent/model-router.json
```

Edit `capable` / `cheap` lists. Each entry:

```json
{ "provider": "anthropic", "model": "claude-haiku-4-5", "thinkingLevel": "off" }
```

`thinkingLevel` is optional and applied when that model is routed in.
Find model ids with `pi --list-models`.

### 2. Run the laya decision server

```bash
pip install "laya[serve]"
laya-serve                      # listens on http://127.0.0.1:8000
```

or use the bundled helper (creates a venv, installs `laya[serve]`, starts the
server):

```bash
scripts/start-laya.sh
```

The first request downloads the checkpoint (~850 MB) from Hugging Face.
Preload with `LAYA_PRELOAD=1` for long-running use. The server automatically
routes English prompts to the `laya` checkpoint and non-English prompts to
`laya-multilingual`. See the [laya docs](https://github.com/NandhaKishorM/laya)
for GPU, Docker, and fine-tuning options.

If the server is not running, the extension transparently falls back to
heuristics (with a one-time warning), so pi keeps working.

### 3. Reload pi and check

Run `/reload` (or restart pi), then `/router` to see the status. The footer
shows `router: cheap:claude-haiku-4-5 [laya 0.93]` style decisions.

## Commands & markers

| Input | Effect |
|---|---|
| `/router` | Show routing status and config |
| `/router on` / `/router off` | Enable / disable routing |
| `/router auto` | Resume auto-routing after a manual model pick |
| `/router decision` | Toggle the laya decision step (heuristics only when off) |
| `/router big` / `/router small` | Pin a tier for the next request |
| `!big <msg>` / `!small <msg>` | Same, inline (prefix is stripped before sending) |

## Configuration reference

`~/.pi/agent/model-router.json` (global) and `<cwd>/.pi/model-router.json`
(project; merged per-key, project wins). See `config/model-router.example.json`
for a full example.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Routing on at startup |
| `defaultTier` | `"cheap"` | Tier when nothing matches (heuristic fallback) |
| `capable` / `cheap` | `[]` | Ordered model candidate lists |
| `decision.enabled` | `true` | Use the laya decision model |
| `decision.mode` | `"score"` | `\"score\"` (3 capability levels) or `\"choice\"` (capable vs cheap) |
| `decision.url` | `http://127.0.0.1:8000` | `laya-serve` base URL |
| `decision.apiKey` | – | Bearer token; `$VAR` resolves from env |
| `decision.timeoutMs` | `2000` | Give up on the decision call, fall back to heuristics |
| `decision.capableThreshold` | `0.6` | Capability needed for the capable tier (see **Tuning the bias**) |
| `decision.minConfidence` | `0.4` | Below this the answer is not trusted, so the request goes **cheap** |
| `decision.stateChars` | `4000` | Prompt prefix length sent to laya |
| `decision.scoreCriteria` | built-in (3 levels) | Score-mode levels the model classifies against |
| `decision.criteria` / `decision.instructions` | built-in | Choice-mode options and question text |
| `capableKeywords` / `cheapKeywords` | see example | Heuristic keyword triggers (fallback only) |
| `promptLengthThreshold` | `3000` | Heuristic (fallback): longer prompts → capable |
| `imagesForceCapable` | `true` | Image attachments → capable (cheap models often lack vision) |
| `stickyCapableRequests` | `0` | Stay capable for N requests after a capable one |
| `bigPrefix` / `smallPrefix` | `!big` / `!small` | One-shot markers |
| `notify` | `true` | Notify when routing switches the model |

## Tuning the bias

The single most useful knob is `decision.capableThreshold`:

| Goal | Setting |
|---|---|
| Send almost everything to the cheap model | `0.75` |
| **Default** — routine never escalates, complex still does | `0.6` |
| Catch more mid-complexity work (more capable usage) | `0.45` |

If you want a different split, edit `decision.scoreCriteria` — the wording is
what the model actually classifies against.

## Notes & caveats

- `pi.setModel` persists the selected model as pi's default in settings and
  appends a model-change entry to the session — that is the only public API
  for switching models, so frequent routing rewrites the default each time the
  tier changes. This is cosmetic but worth knowing.
- Routing happens once per agent run; mid-run steering/follow-up messages keep
  the model of that run.
- The decision call sees only the prompt text (first `stateChars` chars), not
  the whole conversation.
- The explicit `!big`/`!small` markers always win when you want certainty.

## License

MIT
