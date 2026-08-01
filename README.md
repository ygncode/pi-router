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
  "ranking": ["frontier", "balanced", "efficient", "fast"],
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
6. Falls back to the current route or `fallbackRoute` if classification fails.

This adds one small model request before each unpinned agent run. Pinning a route with `/router use ...` bypasses the classifier call.

## Default models

| Purpose | Default model | Thinking |
|---|---|---:|
| Classifier | `deepseek/deepseek-v4-flash` | low |
| `fast` | `openai-codex/gpt-5.6-luna` | low |
| `balanced` | `openai-codex/gpt-5.6-terra` | medium |
| `frontier` | `openai-codex/gpt-5.6-sol` | high |
| `efficient` | `deepseek/deepseek-v4-pro` | high |

The classifier is instructed to interpret the routes as follows:

- **fast:** quickest configured target for clear, narrow, mechanical work
- **balanced:** default target for normal implementation, debugging, testing, and review
- **frontier:** strongest configured target for difficult or high-value work
- **efficient:** strong lower-cost/large-context alternative, not a presumed domain specialist

## Benchmark basis and limitations

As of August 1, 2026, the official [SWE-bench leaderboards](https://www.swebench.com/) do **not** contain the exact GPT-5.6 Sol/Terra/Luna or DeepSeek V4 Pro models, so the router does not claim direct benchmark evidence for their relative performance.

The closest comparable same-harness predecessor entries currently shown are:

| mini-SWE-agent harness | GPT-5.2 Codex | DeepSeek V3.2 | Reported cost |
|---|---:|---:|---:|
| SWE-bench Verified | 72.8% | 70.0% (high reasoning) | approximately equal ($224.71 vs $223.92 total) |
| SWE-bench Multilingual | 66.3% | 59.0% | DeepSeek lower ($115.15 vs $198.65 total) |

These results are weak family-level priors, not measurements of the configured models. They support treating Codex as the maximum-quality default and DeepSeek as a potentially cost-efficient alternative; they do not support calling DeepSeek a security, terminal, or algorithm specialist. Results depend on the agent scaffold, reasoning setting, limits, and model version.

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
      "thinkingLevel": "low"
    },
    "balanced": {
      "provider": "openai-codex",
      "model": "gpt-5.6-terra",
      "thinkingLevel": "medium"
    },
    "frontier": {
      "provider": "openai-codex",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "high"
    },
    "efficient": {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "thinkingLevel": "high"
    }
  }
}
```

Models must already exist in Pi's model registry and have authentication configured. The router never stores API keys. Configure providers in `~/.pi/agent/models.json` and authentication through `/login` as usual.

Configuration is strict: unknown settings, invalid types, and out-of-range numbers disable the router instead of silently using defaults. Fix the file and run `/router reload`. Set a target's `thinkingLevel` to `null` to use the provider default.

## Privacy and accounting

The classifier provider receives the current prompt and the configured amount of recent conversation. `maxPromptChars` limits the request sent for classification. Set `contextMessages` or `maxContextChars` to `0` to classify only the current request.

The classifier is a separate nested request and is not restricted by Pi's main-model scope. Configure `classifier` explicitly if that scope reflects a provider privacy boundary.

When `logDecisions` is enabled, the selected and recommended routes, ranking, classifier confidence and reason, fallback reason, classifier identity, and classifier usage are stored as non-context session entries. They are not sent to the main model. Nested classifier usage is recorded in those entries but is not currently added to Pi's built-in session usage total.
