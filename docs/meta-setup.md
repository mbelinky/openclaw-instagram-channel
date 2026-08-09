# Connect the Instagram channel to Meta

This guide connects one Instagram professional account to one OpenClaw agent. It uses Meta's **Instagram API with Instagram Login**, an Instagram User access token, and `graph.instagram.com`. It does not use Facebook Login or a Facebook Page access token.

Meta changes dashboard labels from time to time. If a label differs, follow the matching item in the Instagram product's setup checklist.

## What a person must do

A person must complete any Meta login, two-factor authentication, account selection, permission grant, business verification, or app review screen. An agent can handle the repository, OpenClaw config, environment variable names, validation, and service restart.

Do not paste access tokens or the Meta app secret into chat, source files, `openclaw.json`, command output, or logs. Put them directly into the secret or environment mechanism used by the OpenClaw gateway service.

Before starting, collect:

- A Meta developer account that can create or edit the app.
- An Instagram Business or Creator account. Personal accounts are not supported.
- A public HTTPS URL that reaches the OpenClaw gateway.
- The OpenClaw agent id that should answer Instagram messages.
- A short local account id, such as `studio`. This is only an OpenClaw name.

## 1. Install the plugin

For a normal installation:

```bash
openclaw plugins install npm:openclaw-channel-instagram
openclaw plugins inspect instagram --runtime
```

For development from this repository:

```bash
npm install
npm run build
openclaw plugins install .
openclaw plugins inspect instagram --runtime
```

The last command should identify `instagram` as a channel plugin without a load error.

## 2. Create and connect the Meta app

1. Open the [Meta app dashboard](https://developers.facebook.com/apps/) and create or select an app.
2. Add **Instagram API** and choose **API setup with Instagram login**. Do not choose the Facebook Login setup for this plugin.
3. Connect the Instagram Business or Creator account that OpenClaw will answer for.
4. In the dashboard's token setup, request:
   - `instagram_business_basic`
   - `instagram_business_manage_messages`
5. Add `instagram_business_manage_comments` only if you plan to enable comment handling later.
6. Use the connected Instagram account to approve the requested permissions and generate its Instagram User access token.
7. Record the numeric Instagram user id shown for the connected professional account. This becomes `igUserId` in OpenClaw.

For a first beta test, keep the Meta app in development mode and use an account that has the required app and Instagram roles. To let unrelated Instagram accounts authenticate with your app, Meta may require Live mode, Advanced Access, business verification, and app review. Follow the requirements shown for your app in the dashboard.

The plugin consumes the token but does not run Meta's login screen. Authentication happens in Meta, then the resulting token is stored for the gateway service.

## 3. Configure the Meta webhook

Create a long random webhook verify token. This is a value you choose, and it is different from the Meta app secret and Instagram access token.

In the Instagram product's webhook settings:

1. Set the callback URL to `https://YOUR-PUBLIC-GATEWAY/webhook/instagram`.
2. Set the verify token to the exact value you will store as `INSTAGRAM_VERIFY_TOKEN`.
3. Complete Meta's callback verification.
4. Subscribe the connected professional account to the `messages` field.
5. Subscribe to `comments` only after comment handling is enabled and the access token includes `instagram_business_manage_comments`.

The callback must be reachable from the public internet over HTTPS. If a reverse proxy sits in front of OpenClaw, it must pass the request body unchanged because the plugin verifies Meta's signature against the raw bytes.

## 4. Store the three secrets

Add these variables to the environment used by the OpenClaw gateway service:

```bash
INSTAGRAM_APP_SECRET=<Meta app secret>
INSTAGRAM_VERIFY_TOKEN=<random value used in the webhook screen>
INSTAGRAM_ACCESS_TOKEN_STUDIO=<Instagram User access token>
```

Replace `STUDIO` with the normalized local account id. OpenClaw uppercases it and changes every non-alphanumeric character to `_`. For example, `main-shop` becomes `INSTAGRAM_ACCESS_TOKEN_MAIN_SHOP`.

Restarting a service does not automatically copy variables from your current terminal. Store the values wherever that service normally receives its environment. Check the token's expiration in Meta and rotate it before it expires.

## 5. Add the OpenClaw configuration

Merge this shape into the active config. Use `openclaw config file` to find it. Preserve all unrelated accounts, plugin entries, and bindings.

```json
{
  "channels": {
    "instagram": {
      "enabled": true,
      "defaultAccount": "studio",
      "accounts": {
        "studio": {
          "igUserId": "17840000000000000",
          "dmPolicy": "open"
        }
      }
    }
  },
  "bindings": [
    {
      "agentId": "customer-agent",
      "match": {
        "channel": "instagram",
        "accountId": "studio"
      }
    }
  ],
  "plugins": {
    "enabled": true,
    "allow": ["instagram"],
    "entries": {
      "instagram": {
        "enabled": true
      }
    }
  }
}
```

Replace `studio`, `customer-agent`, and the sample `igUserId`. `dmPolicy: "open"` accepts messages from any Instagram user who can reach the professional account. To restrict it, use `dmPolicy: "allowlist"` plus numeric Instagram-scoped sender ids in `allowFrom`.

Validate and restart:

```bash
openclaw config validate
openclaw plugins doctor
openclaw gateway restart
openclaw gateway status --require-rpc
```

## 6. Prove the connection

1. Confirm Meta shows the callback as verified and the professional account subscribed to `messages`.
2. Send a new DM from a different Instagram account to the connected professional account. Meta requires the Instagram user to start the conversation.
3. Confirm the DM reaches the intended OpenClaw agent and its reply appears once in Instagram.
4. If a Meta Business Suite auto-reply also answers, disable the overlapping automation or use a separate account.

The connection is ready when the config validates, the gateway is healthy, Meta accepts the callback, and one real incoming DM receives one agent reply.

## Agent handoff checklist

An agent configuring this plugin should:

1. Read this guide and inspect the existing config before changing anything.
2. Preserve unrelated settings and existing bindings.
3. Keep secrets out of files, chat, shell output, and logs.
4. Ask the person to complete only Meta login, two-factor authentication, account selection, grants, verification, and review screens.
5. Keep comments disabled for the first DM-only test.
6. Run the install, config validation, plugin check, gateway restart, and health check.
7. Stop with one clear remaining action if the real Instagram DM test still needs a person.

## Common failures

- **Meta rejects callback verification:** the public URL is wrong, the gateway is unavailable, or `INSTAGRAM_VERIFY_TOKEN` does not exactly match Meta's value.
- **The plugin returns `403 Invalid signature`:** `INSTAGRAM_APP_SECRET` is wrong or a proxy changed the raw request body.
- **The plugin says the account is not configured:** `igUserId`, one of the shared webhook secrets, or `INSTAGRAM_ACCESS_TOKEN_<ACCOUNT_ID>` is missing from the gateway service environment.
- **Meta accepts the webhook but no DM arrives:** the app or Instagram account lacks the required test role, the account is not subscribed to `messages`, or the sender has not started the conversation.
- **Sending fails with a permission error:** regenerate the Instagram User access token after granting `instagram_business_manage_messages`.
- **Two replies appear:** Meta Business Suite and OpenClaw are both answering the same message.

## Meta references

- [Meta app dashboard](https://developers.facebook.com/apps/)
- [Meta's Instagram API documentation and request collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [OpenClaw plugin commands](https://docs.openclaw.ai/cli/plugins)
- [OpenClaw config commands](https://docs.openclaw.ai/cli/config)
