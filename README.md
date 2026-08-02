# Pi Model Router

An LLM-based model-routing extension for [pi](https://github.com/earendil-works/pi). Before each agent run, a small low-cost classifier model reads the request plus limited recent conversation context and chooses the best configured model for the task.

By default, `deepseek/deepseek-v4-flash` performs classification. There is no keyword-based routing.

## How routing works

Before the main agent starts, the classifier receives:

- The current request, capped at 50,000 characters by default
- Up to six recent user/assistant messages, capped at 6,000 characters
- Current context-window usage
- Whether images are attached
- The active route
- The selected cost/quality policy
- The models configured for each route

It returns strict JSON:

```json
{
  "route": "frontier",
  "ranking": ["frontier", "balanced", "fast", "efficient"],
  "confidence": 0.86,
  "reason": "Ambiguous cross-system debugging task"
}
```

The router then:

1. Keeps the current route when the recommendation differs but confidence is below `minSwitchConfidence`. This reduces unnecessary prompt-cache misses.
2. Tries models in the returned ranking order.
3. Honors Pi's active model scope (`--models` or `enabledModels`) and any thinking level pinned by that scope.
4. Skips unavailable models and models that cannot accept attached images.
5. Switches with `pi.setModel()` and applies the scoped or route-configured thinking level.
6. Continues through the ranked routes when a model switch or authentication resolution fails.
7. Falls back to the current route or `fallbackRoute` if classification fails.

This adds one small model request before each unpinned agent run. Pinning a route with `/router use ...` bypasses the classifier call.

## Default routes

| Route | Model | Thinking | Best for |
|---|---|---:|---|
| `efficient` | `openai-codex/gpt-5.6-luna` | high | Cheap and decent quality: docs, simple fixes, boilerplate, and low-stakes tasks |
| `fast` | `openai-codex/gpt-5.6-luna` | max | Best cost/performance for most day-to-day coding |
| `balanced` | `openai-codex/gpt-5.6-terra` | max | Complex, multi-file, or higher-risk work |
| `frontier` | `openai-codex/gpt-5.6-sol` | high | Architecture, hard reasoning, and orchestration |

The classifier remains `deepseek/deepseek-v4-flash` at low thinking. The route descriptions are operator guidance, not benchmark results.

## Inspiration and evaluation status

**This extension has not been benchmarked.** We have not run a controlled evaluation showing that its routing decisions improve quality, cost, latency, or task-completion rates over using one model. The default routes are opinionated starting points, not an empirical ranking of the configured models.

The project is inspired by broader work on combining and orchestrating multiple models:

- [OpenRouter Fusion](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) sends a task to a panel of models and synthesizes their outputs with a judge. OpenRouter reports gains on its 100-task DRACO deep-research evaluation.
- [Sakana Fugu](https://sakana.ai/fugu/) dynamically assembles and coordinates agents from a model pool, with learned multi-agent orchestration across complex tasks.

Pi Model Router is much simpler than either system: one classifier chooses one configured model before an agent run. It does not execute models in parallel, synthesize multiple answers, assign agents roles, or use a learned orchestration policy. Results reported for Fusion or Fugu therefore do **not** validate this extension or its default model assignments.

Treat the defaults as hypotheses. Before relying on the router for production work, evaluate it on representative tasks and compare correctness, completion rate, latency, model-switch frequency, cache impact, and total classifier-plus-agent cost against fixed-model baselines.

## Policies

- **cost:** select the least expensive route likely to finish correctly
- **balance:** optimize the quality/cost tradeoff
- **intelligence:** optimize correctness and capability

The policy changes the classifier instructions; it does not use hard-coded token prices.

## Installation

Requires Pi 0.83 or newer and Node.js 22.19 or newer.

```bash
pi install npm:@ygncode/pi-model-router
```

Then start Pi normally and run `/router setup`. To install from Git instead:

```bash
pi install git:github.com/ygncode/pi-router
```

### Local development

```bash
git clone https://github.com/ygncode/pi-router.git
cd pi-router
npm install
npm test
npm run check
pi -e ./src/index.ts
```

For an ongoing local installation, run `pi install /absolute/path/to/pi-router`. Use `/reload` after editing the extension.

### Maintainer release

Git tags matching `v*` trigger `.github/workflows/release.yml`. The workflow validates the package, publishes the matching version to npm with provenance, and creates a GitHub release.

Configure an npm automation or granular access token once:

```bash
gh secret set NPM_TOKEN --repo ygncode/pi-router
```

For each release, update and commit the version first, then push the matching tag:

```bash
npm version 0.1.0 --no-git-tag-version
npm install --package-lock-only
# review, test, commit, and push the version change

git tag v0.1.0
git push origin v0.1.0
```

The workflow refuses to publish when the tag and `package.json` versions differ. Prerelease versions such as `0.2.0-beta.1` publish under the corresponding npm dist-tag (`beta` in this example).

## Commands

```text
/router status
/router setup                    # configure classifier and route models
/router cost
/router balance
/router intelligence
/router use fast|balanced|frontier|efficient
/router auto                     # remove pin and resume LLM classification
/router test <prompt>            # classify without switching; makes a classifier API call
/router reload
/router on
/router off
```

CLI flags:

```bash
pi --router-mode cost
pi --router-mode intelligence
pi --router-off
```

## Configuration

Run `/router setup`, or create either:

- Global: `~/.pi/agent/router.json`
- Project: `.pi/router.json`

Project settings override global settings and are read only for trusted projects. See [`router.example.json`](./router.example.json) for the complete configuration.

```json
{
  "enabled": true,
  "mode": "balance",
  "notify": true,
  "logDecisions": true,
  "classifier": {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "thinkingLevel": "low"
  },
  "classifierMaxTokens": 256,
  "classifierTimeoutMs": 15000,
  "contextMessages": 6,
  "maxContextChars": 6000,
  "maxPromptChars": 50000,
  "minSwitchConfidence": 0.7,
  "fallbackRoute": "balanced",
  "models": {
    "fast": {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "thinkingLevel": "max"
    },
    "balanced": {
      "provider": "openai-codex",
      "model": "gpt-5.6-terra",
      "thinkingLevel": "max"
    },
    "frontier": {
      "provider": "openai-codex",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "high"
    },
    "efficient": {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "thinkingLevel": "high"
    }
  }
}
```

Models must already exist in Pi's model registry and have authentication configured. The router never stores API keys. Configure providers in `~/.pi/agent/models.json` and authentication through `/login` as usual.

Configuration is strict: unknown settings, invalid types, and out-of-range numbers disable the router instead of silently using defaults. Fix the file and run `/router reload`. Set a route target's `thinkingLevel` to `null` to retain Pi's current session thinking level when that route is selected. For the classifier, `null` disables explicit reasoning.

The default route assignments are efficient=Luna High, fast=Luna Max, balanced=Terra Max, and frontier=Sol High. The default fallback is `balanced`.

## Privacy and accounting

The classifier provider receives the current prompt and the configured amount of recent conversation. `maxPromptChars` limits the request sent for classification. Set `contextMessages` or `maxContextChars` to `0` to classify only the current request.

The classifier is a separate nested request and is not restricted by Pi's main-model scope. Configure `classifier` explicitly if that scope reflects a provider privacy boundary.

When `logDecisions` is enabled, the selected and recommended routes, ranking, classifier confidence and reason, fallback reason, classifier identity, and classifier usage are stored as non-context session entries. They are not sent to the main model. Nested classifier usage is recorded in those entries but is not currently added to Pi's built-in session usage total.
