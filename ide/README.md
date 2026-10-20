# ide

What turns the upstream sources into this product.

## `product.overlay.json`

The identity merged into the `product.json` of a source build. Only the keys listed
are touched; everything else keeps its upstream value. Keys beginning with an
underscore are notes for a human and are skipped by the build.

Two things it deliberately does **not** do:

- it does not carry the icon or the file descriptions, because those are compiled
  into the executable and need the resource patch step of a source build;
- it does not decide which endpoints to remove, because that list is shared with
  the release check and lives in `vendor-hosts.txt`.

## `vendor-hosts.txt`

Hosts that belong to another vendor. `scripts/build-ide.ps1` empties every URL in
`product.json` pointing at one of them, and `scripts/check_branding.py` asserts
that none survives into a release. One file, because two copies of that rule would
drift and a release could then pass a check the build never applied.

The two download feeds (`nodejsArtifactFeed`, `electronArtifactFeed`) are exempt in
both places: they are read while packaging to fetch Node and Electron, and are
never contacted by the installed product.

## `upstream-product.json`

A pristine copy of `product.json` from `microsoft/vscode` at the tag this repository
builds (`1.142.0`), unmodified, MIT-licensed, taken with:

```
git -C <clone> show 1.142.0:product.json
```

It is a fixture, not a product file. It lets
`scripts/tests/test_check_branding.py` prove that the overlay produces a correct
manifest for a specific upstream version, on any machine, with no toolchain and no
network. When the build moves to a newer tag, this file moves with it, and the test
is what says whether the overlay still fits.

## `vscode-node-version.txt`

The Node version the sources ask for in `.nvmrc`, kept here so the workflow and a
local build pin the same one. On `1.142.0` it is `24.18.0`.