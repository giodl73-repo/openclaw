# Lobster Host

This bundled plugin registers the inactive `lobster/host` integration bundle.
It does not select a model adapter, acquire credentials, start the reverse
carrier, or route provider traffic.

The plugin is disabled by default. A Lobster deployment can expose the bundle
inventory with:

```json5
{
  plugins: {
    entries: {
      "lobster-host": {
        enabled: true,
      },
    },
  },
}
```

After startup, Status and Doctor report every contribution as unresolved until
its semantic owner publishes readiness for the same bundle generation. D1b
supplies the matching Lobster runtime and deployment metadata; later adoption
work owns configuration selection and authority cutover.
