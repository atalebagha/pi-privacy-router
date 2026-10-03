# pi-privacy-router

A [pi](https://pi.dev) extension that adds one model, `privacy-router/auto`, which picks the real model for every request and keeps private work on your machine:

| Your message | Goes to (default) | Why |
|---|---|---|
| Coding, debugging, planning | `anthropic/claude-sonnet-5` | strongest at code |
| Live data: weather, news, prices, latest versions | `openai-codex/gpt-6-sol` | good at web lookups |
| Anything else | stays on the current model | avoids prompt-cache misses |
| Anything private | a local Ollama model, **for the rest of the session** | never sent to an AI provider |

A small local model (`qwen3:8b` by default, about 200 ms warm) reads each new message to pick the lane and to check for personal information. The models are defaults; set your own in `privacy-router.json`.

When one cloud lane hits its plan's usage limit (for example Anthropic's "You're out of extra usage"), the router retries the turn on the other cloud lane and skips the exhausted one for 60 minutes (`quotaCooldownMinutes`). If both lanes are exhausted, the error is shown. Transient errors such as "overloaded" are retried by pi on the same model.

> Status: early (0.x). Privacy protection is best-effort; read [Known gaps](#known-gaps) before relying on it.

## Requirements

- pi 0.99.1 or later
- [Ollama](https://ollama.com) running locally
- Credentials in pi for the cloud lanes you use (`/login`); a lane whose model is missing or not logged in is reported at startup
- RAM for the local models: the defaults (`qwen3:8b` classifier plus the 35B worker) need about 30 GB free; on smaller machines use a smaller local worker (see [Memory](#memory))

## Install

```bash
ollama pull qwen3:8b                 # classifier
ollama pull qwen3.6:35b              # local worker for private sessions
ollama create qwen3.6:35b-pi -f ollama/Modelfile.qwen3.6-35b-pi   # same model with a 64k context
pi install git:github.com/atalebagha/pi-privacy-router
pi --model privacy-router/auto
```

The Modelfile is in this repository (`ollama/`); it sets `num_ctx`, because Ollama's OpenAI-compatible endpoint otherwise uses its own default context size.

The router needs the local worker registered with pi. Create `~/.pi/agent/models.json` (or merge the `ollama` provider into an existing one):

```json
{
	"providers": {
		"ollama": {
			"baseUrl": "http://localhost:11434/v1",
			"api": "openai-completions",
			"apiKey": "ollama",
			"models": [
				{
					"id": "qwen3.6:35b-pi",
					"name": "Qwen 3.6 35B (local, 64k)",
					"input": ["text", "image"],
					"contextWindow": 65536,
					"maxTokens": 16384
				}
			]
		}
	}
}
```

`contextWindow` must match the Modelfile's `num_ctx`, so pi compacts before Ollama would silently truncate. `pi --list-models | grep qwen3.6:35b-pi` confirms it is registered. To make the router pi's default model, set `"defaultProvider": "privacy-router"` and `"defaultModel": "auto"` in `~/.pi/agent/settings.json`.

## Private sessions

A session locks to the local model, permanently, when any of these happen:

- you type `#private` anywhere in a message, or run `/local`
- pi starts inside, or your message names, a path in `sensitivePaths`
- a message or a tool result contains a secret (API keys, tokens, private keys, JWTs, `password=…`)
- the local classifier says a message contains personal information (health, money, IDs, legal matters, family, relationships)

If the session was already long when it locked, the history will not fit the local model's window. The cloud model that wrote the last reply then summarizes the history up to that reply, which it had already received with every request. Your message that triggered the lock, and everything after it, stays local and is kept word for word. If that model is unavailable, a local note of your earlier requests takes the history's place.

Once locked, only local tools run (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `todo`, `ask_user_question`), switching to a cloud model with `/model` is reverted, and prompt-cache warming stops. A session never unlocks in place: every request carries the whole conversation, so unlocking would send the private part on the next message. To use cloud models again, run `/leave-local` (below) or start a new session.

On a cloud lane, reads of private paths and secret files (`.env`, `*.pem`, `id_*`, `auth.json`, …) are blocked before they happen.

If Ollama is not running, messages are **refused**, not sent to the cloud unchecked. Set `"onPrivacyCheckFailure": "warn"` to trade that for availability.

## Memory

The classifier and the local worker each need RAM while loaded. If your machine cannot keep both resident, loading the worker for a private session evicts the classifier. That is fine (a private session never calls the classifier), but the next normal message reloads the classifier cold, which takes a few seconds. Raise `"ollama": { "timeoutMs": 8000 }` so that message is not refused; the default is 1500 ms. With less RAM, register a smaller local worker and set `lanes.local` to it.

## Commands

| Command | Effect |
|---|---|
| `/local` | lock this session to the local model |
| `/leave-local` | go back to the last cloud reply before the lock, without summarizing the private part; cloud routing resumes on your next message, and the private part stays on its own branch (`/tree` back to it locks again) |
| `/route <claude\|claude-max\|gpt>` | pin a cloud model until `/route auto`; the pin pauses while its lane is cooling down after a usage limit |
| `/route auto` | back to automatic routing |
| `/privacy` | lane, lock reason, pin, classifier health, last decision |

## Configuration: `~/.pi/agent/privacy-router.json`

Every key is optional; missing keys use the defaults in `src/config.ts`. A file that exists but is invalid makes the router refuse requests until fixed (it is re-read on every request, so no restart is needed). Set `PI_PRIVACY_ROUTER_CONFIG` to use another path.

```json
{
	"ollama": { "baseUrl": "http://localhost:11434", "classifierModel": "qwen3:8b", "timeoutMs": 1500, "keepAlive": "30m" },
	"lanes": {
		"claude": "anthropic/claude-sonnet-5",
		"gpt": "openai-codex/gpt-6-sol",
		"local": "ollama/qwen3.6:35b-pi"
	},
	"defaultLane": "claude",
	"pinTargets": {
		"claude": { "lane": "claude" },
		"claude-max": { "lane": "claude", "model": "anthropic/claude-opus-5" },
		"gpt": { "lane": "gpt" }
	},
	"minProb": 0.6,
	"quotaCooldownMinutes": 60,
	"onPrivacyCheckFailure": "block",
	"sensitivePaths": ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.config/gh/**", "~/.pi/agent/auth.json"],
	"extraSecretFilenames": [],
	"lockedToolAllowlist": ["read", "write", "edit", "bash", "grep", "find", "ls", "todo", "ask_user_question"]
}
```

Add your own private folders to `sensitivePaths` (for example `"~/Documents/**"`). `ollama.baseUrl` must be a localhost URL: the classifier reads your private text.

If you change `classifierModel`, run `npm run eval` from a clone of this repository first: the gates (category accuracy >= 90 %, no code/live misroutes, personal-information recall >= 95 %) are only verified for `qwen3:8b`.

## Known gaps

1. Tool results are checked for secrets and paths, not for personal information.
2. The personal-information classifier is best-effort. `npm run eval` reports 100 % recall on 44 cases, but those cases also guided the prompt, so real-world recall is lower; `#private` and `/local` are the guarantees.
3. Images are not scanned.
4. `bash` still works in private sessions and can reach the network; the threat model is "never send to an AI provider", not "contain a hostile model".
5. Subagents already running when a session locks are not stopped; new subagent calls are blocked.
6. Observability extensions may upload prompts and responses to their own service; configure them to send metadata only.
7. Runs with extensions disabled are not protected.
8. A locked session whose *private* part alone outgrows the local model (for example a pasted document larger than the window) still cannot be summarized; start a new session.
9. The lock-time handoff assumes every request carried the branch as pi projects it. An extension that strips messages from requests is safe only if it also filters pi's compaction input and loads before this router.
10. Do not install it next to another extension that registers `/local`, `/leave-local`, `/route` or `/privacy`.

## Development

```bash
npm ci
npm test            # unit + wiring tests (no network)
npm run eval        # live classifier eval against Ollama
npm run typecheck
npm run lint
npm run format
```

## License

Apache-2.0. See [LICENSE](LICENSE).
