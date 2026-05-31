---
summary: "Adds configured catalog feed source validation for skills and plugins."
read_when:
  - You are installing, configuring, or auditing the feeds plugin
title: "Feeds plugin"
---

# Feeds plugin

Adds configured catalog feed source validation, search, install handoff, lifecycle tooling, and optional native `skills search` / `plugins search` feed integration.

## Distribution

- Package: `@openclaw/feeds`
- Install route: included in OpenClaw

## Surface

plugin

## Native Search

`openclaw skills search` and `openclaw plugins search` continue to use ClawHub by
default. Operators can opt into configured feeds explicitly:

```bash
openclaw skills search calendar --catalog-feeds
openclaw plugins search calendar --feed-source company-approved
```

To make native search use feeds by default, configure the bundled Feeds plugin:

```jsonc
{
  "plugins": {
    "entries": {
      "feeds": {
        "enabled": true,
        "config": {
          "search": {
            "default": true,
            "sources": ["company-approved"],
          },
          "sources": [
            {
              "id": "company-approved",
              "url": "https://feeds.example.com/openclaw/feed.json",
              "trust": "pinned",
              "integrity": "sha256:...",
            },
          ],
        },
      },
    },
  },
}
```

Omit `search.sources` to search all enabled configured feed sources.
