# Building the IDE on a machine without administrator rights

The product is a patched build of the VS Code sources, and that build compiles
eleven native modules with node-gyp. On Windows node-gyp drives `MSBuild` and
`CL`, so the Microsoft C++ toolchain is required and there is no way around it:
LLVM cannot substitute for it, and `node-gyp` has no MinGW backend.

Installing that toolchain normally needs administrator rights. Where they are not
available, these are the options, in the order worth trying.

## 1. Build in CI and run the artifact locally

The build happens on a machine that already has the toolchain, and what comes back
is a portable folder: running it needs no installation and no privileges.

This is not a guess about the runner. `actions/runner-images` lists what the
`windows-2022` image carries, and it includes exactly the components the sources
require:

| component | version on the image |
|---|---|
| `Microsoft.VisualStudio.Workload.NativeDesktop` | 17.14.36517.7 |
| `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` | 17.14.36510.44 |
| `Microsoft.VisualStudio.Component.Windows11SDK.26100` | 17.14.37011.9 |
| `Microsoft.VisualStudio.Component.VC.ATL.Spectre`, `...ATLMFC.Spectre` | 17.14.36510.44 |

`.github/workflows/build-ide.yml` does the whole job: clone the sources at a
pinned tag, compile the extension, brand `product.json`, package
`vscode-win32-x64`, fold the agent in as a built-in extension and the Python core
beside it, then upload the folder as an artifact.

Cost: a build takes roughly half an hour, and Windows runner minutes are free for
public repositories. A private repository spends its included quota at a 2x
multiplier for Windows.

## 2. Borrow the prebuilt native binaries locally

Every module that needs compiling publishes its interface through
`node-addon-api`, which is N-API and therefore ABI-stable across Node and Electron
versions. An installed VS Code family application already contains those binaries
for the same platform, so they can be put in place of a compile:

1. `npm install --ignore-scripts`, so nothing tries to call the compiler.
2. Run the postinstall steps that do not need one, for example `npm rebuild esbuild`.
3. Copy the `.node` files from the installed application's
   `resources/app/node_modules.asar.unpacked` into the matching
   `node_modules/<package>/build/Release/`.

An installed VSCodium carries all of them: `windows_process_tree.node`,
`vscodium-policy-watcher.node`, `spdlog.node`, `keymapping.node`, `watcher.node`,
`vscode-sqlite3.node`, `winregistry.node`, `iselevated.node`, `conpty.node`.

What makes this a development workaround rather than a build: the JavaScript
wrapper and the binary have to agree on the interface, so a version mismatch turns
into a runtime failure rather than a build error. It is worth doing to get a local
run and find problems early, and it is not what ships.

## 3. Copy a portable toolchain from a machine that has one

The MSVC toolset and the Windows SDK are mostly relocatable: copy them from a
machine where they are installed, then point `INCLUDE`, `LIB` and `PATH` at the
copy for the build session. This works, but it is fragile and needs access to such
a machine - at which point building there, or in CI, is the better answer.

## 4. Ask the platform team

`Microsoft.VisualStudio.BuildTools` installed as its own instance does not modify
an existing Visual Studio: separate product, separate folder, no IDE of its own,
nothing added to `PATH`. For an organisation this is usually the sanctioned path
and the least work overall.

## 5. Do not build from source at all

A portable VS Code family distribution plus our extension installed as built-in
and our `product.json` branding gets a working agent IDE with no toolchain and no
privileges. What it does not give is our own binary identity or the ability to
change the workbench itself, which is why it is the last resort rather than the
first.

## What is already in place

- the sources, cloned and branded: `ide/product.overlay.json` is applied to the
  real `product.json` and verified, including the removal of the leftovers that
  named Microsoft services
- `scripts/build-ide.ps1`: probes the toolchain before touching anything, applies
  branding, compiles, and either runs from source or packages
- `scripts/check-prerequisites.ps1`: reports what a machine is missing and the one
  command that fixes it
- the agent: a working core and an extension with a chat panel in the secondary
  side bar, an editor tab, five modes, approvals, diffs and an inline edit