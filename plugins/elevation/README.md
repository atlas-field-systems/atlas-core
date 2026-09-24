# Elevation Lookup example

A separable Plugin implementing the [Plugin container contract](../../protocol/plugin-container.md). It depends on Atlas only through the SDK package.

```sh
docker build -t atlas-elevation:1.0.0 -f plugins/elevation/Dockerfile .
core/bin/atlasctl -root . plugin-install plugins/elevation
core/bin/atlasctl -root . start        # starts Core and installed Plugins
```

The capability `elevation.lookup` takes WGS84 `latitude` and `longitude` in decimal degrees. Lookup is exact against the four synthetic points in `data.json`; there is no interpolation. Elevations are meters above an arbitrary synthetic zero, **not surveyed terrain**. A coordinate without a sample fails, keeping the input as its output.
