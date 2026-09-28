# omp-multi-auth

Multi-account OAuth login for [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi). Add, authenticate, and switch between multiple accounts per provider. OMP's built-in fallback handles rate-limit retry and model fallback.

## Install

```bash
omp install npm:omp-multi-auth
```

Or install from GitHub:

```bash
omp install git:github.com/tuandinh0801/omp-multi-auth
```

## Features

- Multiple OAuth accounts per provider
- Switch active account with `/multi-auth switch`
- Cross-provider model presets with `/multi-auth-preset`
- Built-in quota checks with `/multi-auth limits`
- Project affinity through `.omp/multi-auth.json` and `allowedSubs`
- Labels for organizing accounts
- Interactive TUI management

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
| `/multi-auth switch` | Switch active account/provider |
| `/multi-auth status` | Show account and authentication status |
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

Presets select models across providers. On rate limits, requests fall through to OMP's built-in fallback.

## Project-level configuration

Create `.omp/multi-auth.json` in a project to restrict which subscription provider names are available. `allowedSubs` is an exact allow-list; omit it to allow all configured accounts.

```json
{
  "allowedSubs": ["openai-codex-2", "anthropic-2"]
}
```

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

API-key providers support full multi-account operation. Add an account with `/multi-auth add`, select the provider, then authenticate via `/multi-auth login` (or `/login <name>`) and paste your API key when prompted. Each account stores its own key independently in OMP auth storage.

Cursor and GitLab Duo require custom handlers and are not exposed.

## Built-in limits

Run `/multi-auth limits` to inspect quota and usage information for supported providers. This currently includes built-in quota checks for Codex and Google providers. Results depend on provider availability and authenticated account state.

## Configuration files

| Scope | Path | Contents |
|---|---|---|
| Global | `~/.omp/agent/multi-auth.json` | Subscriptions and presets |
| Project | `.omp/multi-auth.json` | `allowedSubs` allow-list |

## Credits

Originally based on [`pi-multi-pass`](https://github.com/hjanuschka/pi-multi-pass).

## License

MIT
