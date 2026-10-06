# Changelog

## 1.0.2

- Use the public command-detection SDK import to support OpenClaw 2026.10 beta while retaining stable-version compatibility.
- Include the existing setup-channel contract fix for OpenClaw doctor.

## 1.0.1

- Remove deprecated channel environment metadata now covered by the setup entry and channel config schema, clearing the ClawHub validation warning.

## 1.0.0

- First public beta release of the OpenClaw Instagram channel plugin.
- Signed Instagram DM webhooks, account routing, text delivery, first-contact notices, passive engagement reactions, comment handling, and deterministic keyword private replies.
- Public release hardening for configuration validation, token-safe Graph API errors, and outbound send concurrency.
