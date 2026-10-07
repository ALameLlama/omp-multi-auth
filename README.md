# omp-multi-auth

Multi-account authentication for [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi). Add and authenticate accounts for each provider. A subscription pool is a route that shares requests across accounts for one provider.

## Install

Requires OMP 18.6.2 or later.

```bash
omp install npm:omp-multi-auth
```

Or install from GitHub:

```bash
omp install git:github.com/tuandinh0801/omp-multi-auth
```

## Features

- Multiple OAuth and API-key accounts per provider
- Automatic subscription pools for main agents and subagents
- Account and pool selection with `/multi-auth switch`
- Cross-provider model presets with `/multi-auth-preset`
- Built-in quota checks with `/multi-auth limits`
- Project affinity through `.omp/multi-auth.json` and `allowedSubs`
- Labels for organizing accounts
- Interactive TUI management

## Subscription pools

When a provider has an extra configured subscription, the extension registers a `<provider>-pool` route. Two authenticated physical accounts activate automatic pooling. Existing canonical and numbered selections keep the same model ID. Saved agent roles and presets do not change.

OMP's model picker and RPC model selection enter the pool before the next normal prompt. Preset activation enters it immediately. Pool routes are not login accounts. Continue to use physical names such as `openai-codex` and `openai-codex-2` for authentication.

`/multi-auth switch <pool>` selects the pool and clears any pin. `/multi-auth switch <physical>` pins that physical account: subsequent prompts use it directly instead of being re-promoted to the pool, until you switch again. This is how you force a specific account (for example, when the other account is rate-limited).

The main agent and subagents share the active account within the same permitted account group. The pool keeps that account while its measured quota exceeds 15%, or its quota is unknown. At 15% or below, new requests select an account with more quota. If every usable account is low, the pool uses the account with the most remaining quota.

For Codex, the lower of the known five-hour and weekly quotas determines remaining quota. Google checks use the quota for the requested model. Providers without quota checks still share accounts and use native credential failover. Failed or missing quota checks mean unknown quota, not zero quota.

OMP handles bounded retries and account-limit failures. Transient throttling retains native backoff. Account changes affect new requests and safe retries. They do not cancel an open response or resubmit a user prompt.

`/multi-auth status` shows physical accounts, permitted pool members, the active account, and the 15% threshold. The TUI shows the pool model, active physical account, and its quota. A pool can keep serving one permitted account after logout or project filtering. Removing the final extra subscription removes its pool route.

### Host limitations

Pooled Codex models cannot use native Code Mode or `/fast` controls. The extension warns once per session. Use a physical Codex selection without an active automatic pool when you need those controls.

Pooled Anthropic requests use the standard native streaming transport. They do not use OMP's built-in Cowork fetch profile. Provider proxy configuration and explicit caller fetch choices remain effective.

## Commands

### `/multi-auth`

| Command | Description |
|---|---|
| `/multi-auth` | Open account management menu |
| `/multi-auth list` | List configured accounts |
| `/multi-auth add` | Add an account |
| `/multi-auth remove` | Remove an account |
| `/multi-auth login` | Authenticate an account |
| `/multi-auth logout` | Sign out an account |
| `/multi-auth switch` | Select an account/provider or pool (physical selection pins it) |
| `/multi-auth status` | Show physical accounts and pool routing status |
| `/multi-auth limits` | Check provider quota and usage |

### `/multi-auth-preset`

| Command | Description |
|---|---|
| `/multi-auth-preset` | Open preset menu |
| `/multi-auth-preset activate` | Activate a preset's best available entry |
| `/multi-auth-preset <name>` | Activate preset by name |
| `/multi-auth-preset create` | Create a preset |
| `/multi-auth-preset list` | List presets |
| `/multi-auth-preset toggle` | Enable or disable a preset |
| `/multi-auth-preset remove` | Delete a preset |

Presets select models across providers. Entries keep their saved physical provider names. Activation automatically enters an available same-provider pool. OMP retains control of model fallback.

## Project-level configuration

Create `.omp/multi-auth.json` in a project to restrict which subscription provider names are available. `allowedSubs` is an exact allow-list; omit it to allow all configured accounts.

```json
{
  "allowedSubs": ["openai-codex-2", "anthropic-2"]
}
```

The allow-list contains exact physical account names, not pool names. Allowing only `openai-codex-2` makes its pool use only that account, even if another account has more quota. If no permitted authenticated account serves the selected model, normal input is blocked. Authentication and account commands remain available for recovery.

## Supported providers

### OAuth

| Provider | Service |
|---|---|
| `anthropic` | Anthropic (Claude Pro/Max) |
| `openai-codex` | ChatGPT Plus/Pro (Codex) |
| `github-copilot` | GitHub Copilot |
| `google-gemini-cli` | Google Cloud Code Assist |
| `google-antigravity` | Antigravity |
| `kimi-code` | Kimi Code |
| `xai-oauth` | xAI Grok OAuth |
| `cursor` | Cursor (browser PKCE OAuth or API key) |
### API key

| Provider | Service |
|---|---|
| `openai` | OpenAI (API key) |
| `deepseek` | DeepSeek |
| `mistral` | Mistral |
| `groq` | Groq |
| `xai` | xAI (API key) |
| `google` | Google Gemini (API key) |
| `openrouter` | OpenRouter |
| `together` | Together AI |
| `fireworks` | Fireworks AI |
| `cerebras` | Cerebras |
| `moonshot` | Moonshot (Kimi) |
| `zai` | Z.AI (GLM) |
| `minimax` | MiniMax (Global) |
| `minimax-cn` | MiniMax (China) |
| `cursor` | Cursor (dashboard API key `crsr_...` / `cursor_...` or browser sign-in) |

API-key providers support full multi-account operation. Add an account with `/multi-auth add`, select the provider, then authenticate via `/multi-auth login` (or `/login <name>`) and paste your API key when prompted. Each account stores its own key independently in OMP auth storage.

For `cursor`, `/multi-auth login` prompts for a dashboard API key (`crsr_...`/`cursor_...`). Submit a key to use token exchange, or leave it blank to sign in via browser PKCE OAuth. Both methods refresh automatically.

## Built-in quotas

Run `/multi-auth limits` to inspect quota and usage information for supported providers. This currently includes built-in quota checks for Codex and Google providers. Results depend on provider availability and authenticated account state.

## Configuration files

| Scope | Path | Contents |
|---|---|---|
| Global | `~/.omp/agent/multi-auth.json` | Subscriptions and presets |
| Project | `.omp/multi-auth.json` | `allowedSubs` allow-list |

## Tests

`npm test` skips host suites. Use `--host` to run them with OMP. The pool suite requires OMP 18.6.2 or later, Node with `node:sqlite`, and Linux user/network namespaces.

The pool suite uses disposable credentials and fake provider responses. It does not use your accounts or send live provider requests.

```bash
node tests/subscription-pool-check.mjs
node tests/run-all.mjs --host
```

For a disposable interactive fixture, run `node tests/subscription-pool-check.mjs --prepare-tui`. Follow its launch command. After the smoke run, delete only the fixture directory that it prints.

## Credits

Originally based on [`pi-multi-pass`](https://github.com/hjanuschka/pi-multi-pass).

## License

MIT
