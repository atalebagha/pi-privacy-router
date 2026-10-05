# pi-privacy-router

A [pi](https://pi.dev) extension that adds one model, `privacy-router/auto`, which picks the real model for every request and keeps private work on your machine:

| Your message | Goes to (default) | Why |
|---|---|---|
| Coding, debugging, planning | `anthropic/claude-sonnet-5`, then `openai-codex/gpt-6-sol` | strongest at code |
| Live data: weather, news, prices, latest versions | `openai-codex/gpt-6-sol`, then `anthropic/claude-sonnet-5` | good at web lookups |
| Anything else | stays on the current model | avoids prompt-cache misses |
| Anything private | a local Ollama model, **for the rest of the session** | never sent to an AI provider |

Each category routes to the first usable model in its list: one pi has, with credentials, whose provider is not cooling down. A small local model (`qwen3:8b` by default, about 200 ms warm) reads each new message to pick the category and to check for personal information. Set your own models and order in `privacy-router.json`.

When a provider hits its plan's usage limit (for example Anthropic's "You're out of extra usage"), the router cools that provider down for 60 minutes (`quotaCooldownMinutes`) and retries the turn on the next usable model in the list. A cooldown covers every model of that provider, because usage limits are per account. If no usable model is left, the error is shown. Transient errors such as "overloaded" are retried by pi on the same model.

> Status: early (0.x). Privacy protection is best-effort; read [Known gaps](#known-gaps) before relying on it.

## Requirements

- pi 0.99.1 or later (tested on 1.0.2; the package accepts `>=0.99.1 <1.1.0`)
- [Ollama](https://ollama.com) running locally
- Credentials in pi (`/login`) for the models in your routes; unusable ones are reported at startup and skipped
- RAM for the local models: the defaults (`qwen3:8b` classifier plus the 35B worker) need about 30 GB free; on smaller machines use a smaller local worker (see [Memory](#memory))

## Install

```bash
ollama pull qwen3:8b                 # classifier
ollama pull qwen3.6:35b              # local worker for private sessions
ollama create qwen3.6:35b-pi -f ollama/Modelfile.qwen3.6-35b-pi   # same model with a 64k context
pi install npm:pi-privacy-router@0.2.1
# alternative, from git: pi install git:github.com/atalebagha/pi-privacy-router
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

- you type `#private` anywhere in a message sent through the router, or run `/local`. With a cloud model selected directly, `#private` does nothing: that model receives the message
- pi starts inside, or your message names, a path in `sensitivePaths`
- a message or a tool result contains a secret: provider key formats, private keys, JWTs, `scheme://user:pass@host` URLs with a real-looking password, and `password=` / `token:`-style assignments, the last only when the value is 16+ characters with a digit and enough randomness. To avoid false alarms on documentation examples, some values are not flagged: any value that looks like a placeholder (`example`, `changeme`, `your_`, `xxx`, `<…>`), assignment values and URL passwords containing dummy, sample, test, fake or mock, and URL passwords containing pass or secret. A real secret containing such a word is missed
- the local classifier says the text contains personal information (health, money, IDs, legal matters, family, relationships)

If the session was already long when it locked, the history will not fit the local model's window. The cloud model that wrote the last reply then summarizes the history up to that reply, which it had already received with every request. Your message that triggered the lock, and everything after it, stays local and is kept word for word. If that model is unavailable, a local note of your earlier requests takes the history's place. When the lock is decided while pi is already summarizing (compaction or a `/tree` summary), the local model summarizes everything itself, and a long session can exceed its context until pi compacts again.

Once locked, only local tools run (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `todo`, `ask_user_question`) and prompt-cache warming stops. A locked session may only use the router, or your configured `private` model while pi serves it from localhost:

- Opening it with another model selected (`pi --model`, `/resume`, `/fork`, `/tree`, `/local`) switches it to `privacy-router/auto` (or, if the router is missing, to the `private` model when the lock allows it). If that switch fails, the model stays and its requests are blocked.
- Requests from it to any other model get an empty body: pi still makes the HTTP request, with your credentials, but no session content is sent. This holds for providers that build the request through pi's payload hook, as all of pi's built-in providers do; a provider added by another extension that ignores the hook is not covered.
- `/compact` and `/tree` summaries with another model are cancelled.
- In a locked session, choosing any other model with `/model` is switched back, and a running turn is stopped. If no allowed model is available to switch to, the choice stays and its requests are blocked.

A session never unlocks in place: every request carries the whole conversation, so unlocking would send the private part on the next message. To use cloud models again, run `/leave-local` (below) or start a new session.

While `privacy-router/auto` is selected in an unlocked session, reads of private paths and secret files (`.env`, `*.pem`, `id_*`, `auth.json`, …) are blocked before they happen. The built-in `read`, `write`, `edit`, `ls`, `grep` and `find` are checked against real paths (symlinks resolved). For `bash` the check is a best-effort scan of the command text, and shell tricks can evade it.

### What is checked for personal information

The check covers the session's text since the last cloud reply, not only your newest message: on new turns, on turns that extensions start, on pi's automatic retries, and on summaries (compaction, `/tree`, `/bug`). It reads windows of 4,000 characters; a long message costs up to 16 classifier calls, a few seconds. Text over about 61,000 characters is refused, or passes with a warning under `"onPrivacyCheckFailure": "warn"`. Refused text stays in the session, so the next messages are refused too: add `#private` to keep the session on the local model, use `/tree` without a summary to go back to before the long text, or start a new session. The window includes text written while a local model was selected, so switching back to the router after a long local-only stretch can be refused the same way.

If the classifier does not answer (not running, still loading, or too slow), new messages, turns that extensions start, retries and summaries are **refused**, not sent to the cloud unchecked. Set `"onPrivacyCheckFailure": "warn"` to trade that for availability.

If `HTTP_PROXY` / `HTTPS_PROXY` are set, also set `NO_PROXY=localhost,127.0.0.1,::1`; otherwise classifier and local-model traffic can pass through the proxy.

## Memory

The classifier and the local worker each need RAM while loaded. If your machine cannot keep both resident, loading the worker for a private session evicts the classifier. That is fine (a private session never calls the classifier), but the next normal message reloads the classifier cold, which takes a few seconds. Raise `"ollama": { "timeoutMs": 8000 }` so that message is not refused; the default is 1500 ms. With less RAM, register a smaller local worker and set `private` to it.

## Commands

| Command | Effect |
|---|---|
| `/local` | lock this session to the local model |
| `/leave-local` | go back to the last cloud reply before the lock, without summarizing the private part; cloud routing resumes on your next message, and the private part stays on its own branch (`/tree` back to it locks again) |
| `/route <name>` | pin the model named in `pins` until `/route auto`; the pin pauses while its provider is cooling down after a usage limit |
| `/route auto` | back to automatic routing |
| `/privacy` | selected and routed model, route, lock reason, pin, cooldowns per provider, config source, classifier health, last decision |

## Configuration: `~/.pi/agent/privacy-router.json`

Every key is optional; missing keys use the defaults in `src/config.ts`, and `routes` merges per category. A file that exists but is invalid makes the router refuse requests until fixed (it is re-read on every request, so no restart is needed). Set `PI_PRIVACY_ROUTER_CONFIG` to use another path.

```json
{
	"ollama": { "baseUrl": "http://localhost:11434", "classifierModel": "qwen3:8b", "timeoutMs": 1500, "keepAlive": "30m" },
	"routes": {
		"code": ["anthropic/claude-sonnet-5", "openai-codex/gpt-6-sol"],
		"live": ["openai-codex/gpt-6-sol", "anthropic/claude-sonnet-5"],
		"general": "stay"
	},
	"private": "ollama/qwen3.6:35b-pi",
	"defaultModel": "anthropic/claude-sonnet-5",
	"pins": {
		"claude": "anthropic/claude-sonnet-5",
		"claude-max": "anthropic/claude-opus-5",
		"gpt": "openai-codex/gpt-6-sol"
	},
	"minProb": 0.6,
	"quotaCooldownMinutes": 60,
	"onPrivacyCheckFailure": "block",
	"sensitivePaths": ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.config/gh/**", "~/.pi/agent/auth.json"],
	"extraSecretFilenames": [],
	"lockedToolAllowlist": ["read", "write", "edit", "bash", "grep", "find", "ls", "todo", "ask_user_question"]
}
```

- `routes.code` / `routes.live`: models in failover order, from any providers pi supports. `routes.general`: `"stay"` keeps the current model; a list routes confident general messages to it.
- `private`: the local model for locked sessions. It must really run locally: a model served from localhost must not forward elsewhere. Ollama `-cloud` / `:cloud` models and local gateways (for example LiteLLM) listen on localhost but forward to other servers; `-cloud` models are rejected, and gateways are not supported.
- `defaultModel`: used before any model has answered and first in the fallback chain; when omitted it defaults to the first `routes.code` model.
- `pins`: `/route <name>` pins that model until `/route auto`.

Add your own private folders to `sensitivePaths` (for example `"~/Documents/**"`). `ollama.baseUrl` must be a localhost URL and `ollama.classifierModel` a local model (not `-cloud`): the classifier reads your private text. `quotaCooldownMinutes` must be at least 1.

If you change `classifierModel`, run `npm run eval` from a clone of this repository first: the gates (category accuracy >= 90 %, no code/live misroutes, personal-information recall >= 95 %) are only verified for `qwen3:8b`.

### Upgrading from 0.1

0.1 files (`lanes`, `defaultLane`, `pinTargets`) keep working: they are translated when loaded, with `code` = [claude lane, gpt lane] and `live` = [gpt lane, claude lane]. Do not mix 0.1 and 0.2 keys in one file. Sessions from 0.1 keep their state, and a locked session stays locked. Going back to 0.1 after writing a 0.2-format `privacy-router.json` makes 0.1 refuse that file (it fails closed); locked sessions stay locked either way.

## Known gaps

1. Tool results are checked for secrets only, not for paths or personal information.
2. The personal-information classifier is best-effort. `npm run eval` reports 100 % recall on 44 cases, but those cases also guided the prompt, so real-world recall is lower; `#private` and `/local` are the guarantees.
3. Images are not scanned.
4. `bash` still works in private sessions and can reach the network; the threat model is "never send to an AI provider", not "contain a hostile model". It can also edit the router's config and session files, so the lock is only as trustworthy as the local model and the files it reads. Adding network tools to `lockedToolAllowlist` weakens the lock.
5. Subagents already running when a session locks are not stopped; new subagent calls are blocked.
6. Logging or sync extensions, for example Langfuse tracing or session mirroring, receive what pi sends them, including locked content. The router cannot stop them; remove them or keep them off privacy work.
7. Runs with extensions disabled are not protected.
8. A locked session whose *private* part alone outgrows the local model (for example a pasted document larger than the window) still cannot be summarized; start a new session.
9. The lock-time handoff assumes every request carried the branch as pi projects it. An extension that strips messages from requests is safe only if it also filters pi's compaction input and loads before this router.
10. Content that other extensions add to requests after routing (pi context hooks) is not scanned.
11. `/share`, `/export` and pi's bug report (`/bug`, which also asks the selected model to summarize the session) include locked branches.
12. The path guard runs only while `privacy-router/auto` is selected in an unlocked session. A cloud model selected directly gets no guard, and in a locked session the path guard does not run; only the tool allowlist applies.
13. Only the built-in file tools and `bash` are inspected; non-built-in tools (MCP, custom tools) are never checked for private paths.
14. Do not install it next to another extension that registers `/local`, `/leave-local`, `/route` or `/privacy`.
15. A locked session's emptied request body stays empty only if no extension loaded after the router rebuilds the request in its own `before_provider_request` handler.
16. Text you type as instructions to `/compact`, to a `/tree` summary, or as a `/bug` description goes to the summarizing model unchecked. Keep personal information out of it, or add `#private` to the session first.

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
