# Lobster Host

This bundled plugin contributes the inactive `lobster/host` integration bundle
and the `lobster/continuity` publication provider. The bundle remains registered
only while the plugin service is active. The provider is registered with the
plugin registry and uses a host-configured durable filesystem root; callers
cannot select a destination, URL, header, or credential.

The plugin is disabled by default. Enabling it requires an absolute durable
publication root and a stable provider generation:

```json5
{
  plugins: {
    entries: {
      "lobster-host": {
        enabled: true,
        config: {
          publicationRoot: "/srv/lobster/continuity",
          providerGeneration: "lobster-continuity-1",
        },
      },
    },
  },
}
```

`publicationRoot` is never supplied by the managed publication caller. Keep it
on storage that survives worker deletion and scope its filesystem permissions
to one continuity trust domain. Change `providerGeneration` only for a
deliberate binding rollout; in-flight receipts are generation-fenced.

The provider streams archives into opaque owner/handoff-derived object names,
verifies size and SHA-256 before acceptance, never overwrites a logical
publication, and stores immutable acceptance metadata. Exact replay returns the
original acceptance; conflicting content fails closed.

After startup, Status and Doctor report all six bundle contributions until
their semantic owners publish readiness for the same bundle generation. The
plugin still does not select a model adapter, acquire credentials, start the
reverse carrier, or route provider traffic.
