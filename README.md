# OpenClaw Instagram channel

Connect Instagram professional-account DMs to OpenClaw agents through Meta's Instagram API with Instagram Login. This is an early beta for teams that can test their own Meta app and send feedback.

It supports signed DM webhooks, multiple accounts, plain-text replies, first-contact notices, story-mention reactions, optional comment handling, deterministic keyword private replies, and human-takeover protection.

## Quick start

The complete [Meta connection guide](docs/meta-setup.md) covers the Meta app, authentication, webhook, OpenClaw configuration, and an end-to-end test. It separates the steps an agent can complete from the Meta login and approval screens that need a person.

The short version is:

1. Create a Meta app with **Instagram API with Instagram Login** and connect an Instagram professional account.
2. Generate an Instagram User access token with `instagram_business_basic` and `instagram_business_manage_messages`.
3. Set Meta's callback URL to `https://YOUR-PUBLIC-GATEWAY/webhook/instagram` and subscribe to `messages`.
4. Put the Meta app secret, webhook verify token, and account access token in the gateway service environment.
5. Add the Instagram account and agent binding to OpenClaw, then restart the gateway.

To delegate the setup, give your agent this prompt after replacing the three placeholders:

```text
Configure the OpenClaw Instagram channel in this repository by following docs/meta-setup.md.

Account id: <short-local-name>
OpenClaw agent id: <agent-id>
Public HTTPS gateway URL: <https://host.example>

Inspect the current OpenClaw config and merge the Instagram account and binding without replacing unrelated settings or bindings. Never print, log, or commit secrets. Ask me only when Meta requires my login, two-factor authentication, account selection, or approval. Leave comment handling off unless I explicitly request it. Build and install the plugin, validate the config, restart the gateway, run the documented checks, and tell me exactly which human Meta step or real Instagram test remains.
```

Install the published package:

```bash
openclaw plugins install npm:openclaw-channel-instagram
```

For development from a checkout:

```bash
npm install
npm run build
openclaw plugins install .
```

Set secrets outside `openclaw.json`:

```bash
INSTAGRAM_APP_SECRET=<set-in-environment>
INSTAGRAM_VERIFY_TOKEN=<set-in-environment>
INSTAGRAM_ACCESS_TOKEN_EXAMPLE=<set-in-environment>
```

The per-account token variable is `INSTAGRAM_ACCESS_TOKEN_<ACCOUNT_ID>`. The account id is uppercased and non-alphanumeric characters become underscores. Store it in the environment used by the gateway service, not only in an interactive shell. Confirm its expiration in Meta's app dashboard and refresh it before it expires.

## Minimal configuration

```json
{
  "channels": {
    "instagram": {
      "enabled": true,
      "defaultAccount": "example",
      "accounts": {
        "example": {
          "igUserId": "17840000000000000",
          "dmPolicy": "open"
        }
      }
    }
  },
  "bindings": [
    {
      "agentId": "example-agent",
      "match": { "channel": "instagram", "accountId": "example" }
    }
  ],
  "plugins": {
    "enabled": true,
    "allow": ["instagram"],
    "entries": { "instagram": { "enabled": true } }
  }
}
```

`allowFrom` is for numeric Instagram-scoped sender IDs, not handles. With `dmPolicy: "allowlist"`, it must contain explicit IDs. A wildcard is rejected there. The legacy wildcard shape remains accepted with `dmPolicy: "open"` so existing installations keep working.

## Keyword private replies

Comment handling is off by default. When enabled, the first matching campaign sends one fixed private reply without an agent or model call.

```json
{
  "comments": {
    "enabled": true,
    "keywordPrivateReplies": [{
      "triggers": {
        "es": ["info"],
        "en": ["hello"],
        "ca": ["details"]
      },
      "replies": {
        "es": "Información: https://example.com/info",
        "en": "Information: https://example.com/info",
        "ca": "Informació: https://example.com/info"
      }
    }]
  }
}
```

Triggers ignore case and diacritics, require whole words, and use language priority `es`, `en`, then `ca`.

## Security and delivery

All inbound POST webhooks require `X-Hub-Signature-256` over the raw request body. Missing or changed signatures receive `403` before JSON parsing. The plugin hashes IDs in its own webhook logs, redacts token-shaped values in Graph API failures, and reads tokens only from environment variables.

Graph API sends use a four-request concurrency guard. Meta's quotas vary by app and account, and Meta can change them. Monitor its rate-limit headers and errors, keep campaigns modest, and do not retry a send when delivery is ambiguous.

## Troubleshooting

- A Business Suite auto-reply and the plugin can both answer the same DM. Disable the overlapping Business Suite automation or route it to a separate account.
- A group or private-account privacy setting can prevent expected webhook delivery. Test with the exact professional account, sender, app role, and webhook field you intend to use.
- `403 Invalid signature` means the app secret, raw body, or proxy path changed. Do not parse or rewrite the body before this plugin sees it.
- Comments do nothing until all three are ready: `comments.enabled`, `instagram_business_manage_comments`, and the `comments` webhook field.
- An account marked not configured is missing its numeric `igUserId`, shared webhook secrets, or its account token environment variable.

## Development

```bash
npm test
```

`npm test` builds the plugin before running the test suite. This repository has no runtime dependencies beyond its existing package set.

## License

MIT. See [LICENSE](LICENSE).
