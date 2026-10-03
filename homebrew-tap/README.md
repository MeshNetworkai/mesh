# mesh-network/homebrew-tap (source copy)

This directory is the source of the Homebrew tap. The release workflow copies `Formula/mesh-node.rb`
into the separate `mesh-network/homebrew-tap` repository on every `v*` tag (Homebrew requires a tap to
be its own repo named `homebrew-<name>`). Users never clone this monorepo:

```sh
brew install mesh-network/tap/mesh-node
mesh-node setup --link <code> --gateway https://<gateway-host>
mesh-node service install
brew upgrade mesh-node            # new versions
```

How the sync works and how to do it by hand: `docs/DISTRIBUTION.md` ("Homebrew tap").
