# Telemetry

Andromity sends usage telemetry so we can see which clients, models and features people use, and where sessions fail. This page lists everything that is sent, how to turn it off, and what is never collected.

Telemetry is **on by default** and can be turned off at any time (see [Turning it off](#turning-it-off)). It never includes your code, prompts or files.

## How you are identified

On first run, Andromity creates a random ID and stores it in `.telemetry_uuid` in its config folder (`%APPDATA%\andromity` on Windows, `~/.andromity` elsewhere, or `ANDROMITY_CONFIG_DIR` if set). Every event carries this ID, so events from the same installation can be linked together.

The ID is not derived from your name, email, account, hostname or hardware. It is **pseudonymous, not anonymous**: it links your events to each other, but not to who you are. Deleting the file gives you a new ID.

## Where it goes

Events are sent over HTTPS to `telemetry.agenticmarket.dev`, a Cloudflare Worker whose source is in [`telemetry-worker/`](telemetry-worker/), and stored in a Cloudflare D1 database. The worker derives your **country** from Cloudflare's request metadata. Your IP address is used only for rate limiting and is never stored.

## What is sent

Every event includes the random ID, the client (`vscode`, `tui`, `cli` or `server`), your OS family (`windows`, `darwin` or `linux`) and the Andromity version.

| Event | When | Additional fields |
|---|---|---|
| `session_start` | A chat session starts | Session ID; provider and model name; whether the provider is local or cloud; reasoning effort setting; number of MCP tools enabled; active profile; session duration so far |
| `session_update` | During a session | Session ID; turn count; session duration |
| `session_end` | A session ends | Session ID; provider and model name; local or cloud; turn count; whether an error occurred; session duration and a coarse duration bucket; counts of shell, file and web tool calls |
| `task_started`, `task_finished` | A request to the agent starts and finishes | Session ID; a random run ID; provider and model name; outcome (`completed`, `failed` or `cancelled`); active seconds; time to first response in milliseconds |
| `feature_use` | You use a feature (for example opening the waterfall) | Session ID when there is one; the feature's name only |
| `weekly_summary` | At most once every 7 days | Names of features used that week (up to 20) |

Model and provider names are the identifiers you configured (for example `anthropic` and `claude-sonnet-4-6`). Values are length-limited and stripped to safe characters before sending, and anything that looks like an API key is removed.

## Feedback you send

**Send Feedback** in VS Code opens a box where you can write a note to the Andromity team. A note is sent only when you submit it, and only with the client, OS family and Andromity version. The worker also stores the country Cloudflare reports for the connection. A note is **not** linked to your telemetry ID, and the worker does not store your IP address. Anything that looks like an API key is removed before it is stored. If you include your email address so we can reply, we use it only for that.

Now and then, after a reply that went well, the chat asks **How's Andromity working for you?** Nothing is sent unless you pick an answer. Picking one sends your choice (Love it, It's OK or Not great), any of the listed annoyances you tick, and the optional note, stored the same way as a note: with the client, OS family, version and country, not linked to your telemetry ID and without your IP address. Usage telemetry records only whether a check-in was shown, answered or dismissed, never your answer. **Don't ask again** on the card stops the check-in for good.

Notes and check-ins are sent whether or not telemetry is on, because you send each one yourself. Air-gap mode turns the feedback box and the check-in off. To delete a note you sent, email hello@agenticmarket.dev with the subject line `Feedback deletion` and roughly what it said and when.

## Joining the waitlist

In VS Code, **Need more? Join the waitlist** on the Andromity provider card, or on a daily-limit card when the gateway offers it, opens a short form in the chat. Nothing is sent until you press **Join the waitlist**. It sends the options you picked for what you would want and where you heard about Andromity, the optional notes you write, and the client, OS family and Andromity version. The worker also stores the country Cloudflare reports for the connection. No email address is asked for; an entry is not linked to your telemetry ID, and the worker does not store your IP address. Anything that looks like an API key is removed before it is stored. Usage telemetry records only that the offer was shown, that the form was opened and that you joined, never your answers. Like a note, an entry is sent whether or not telemetry is on, because you send it yourself. Air-gap mode turns the waitlist off.

## What is never collected

- Prompts, responses, code, file contents, file names or paths
- API keys, tokens, environment variables or configuration values
- Your name, email, username, hostname or hardware identifiers
- Your IP address (used in transit for rate limiting, never stored)

## Turning it off

Any one of these stops all telemetry:

- Set `DO_NOT_TRACK=1` or `ANDROMITY_NO_TELEMETRY=1` in your environment.
- Turn off the telemetry setting in Andromity's settings, or set `telemetry = false` under `[default]` in `config.toml`. In VS Code this is also the `andromity.telemetry` setting.
- In VS Code, turning off VS Code's own telemetry setting also stops the extension's feature events.
- Air-gap mode blocks all telemetry and every other request to Andromity's servers.

Telemetry is also off automatically in CI environments.

When telemetry is off, Andromity also stops fetching tips, news and command content from `telemetry.agenticmarket.dev`.

## Deleting your data

Email hello@agenticmarket.dev with the subject line `Telemetry deletion` and the contents of your `.telemetry_uuid` file. We delete every event linked to that ID.
