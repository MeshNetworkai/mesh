# Homebrew formula for the Mesh node agent.
#
# This file lives in the main repo at homebrew-tap/Formula/mesh-node.rb and is mirrored to the
# `MeshNetworkai/homebrew-tap` repository (Formula/mesh-node.rb) by the release workflow, so that
#
#   brew install meshnetworkai/tap/mesh-node
#   mesh-node setup --link <code> --gateway https://<gateway-host>
#   mesh-node service install
#
# works without this monorepo. `url`, `version` and `sha256` are rewritten on every tag by
# .github/workflows/release.yml (scripts/release/update-formula.sh); do not edit them by hand.
# See docs/DISTRIBUTION.md.
class MeshNode < Formula
  desc "Run a Mesh inference node on your Mac: serve AI replies from Ollama and earn for them"
  homepage "https://github.com/MeshNetworkai/mesh"
  url "https://github.com/MeshNetworkai/mesh/releases/download/v0.1.2/mesh-node-0.1.2-darwin-arm64.tar.gz"
  sha256 "0832992e4347f3e950c0e5d00ea5f46eba26c78527183c5f70e31572d55de80a"
  license "MIT"

  # The bundle is plain JavaScript for Node 18+; Homebrew's `node` is the supported runtime.
  depends_on "node"
  depends_on arch: :arm64
  depends_on :macos

  def install
    libexec.install "libexec/mesh-node.js"
    # Thin wrapper: Homebrew's node, the Cellar bundle, and MESH_INSTALL_CHANNEL so `mesh-node update`
    # points people at `brew upgrade` instead of writing into the Cellar.
    (bin/"mesh-node").write <<~SH
      #!/bin/sh
      export MESH_INSTALL_CHANNEL="${MESH_INSTALL_CHANNEL:-brew}"
      export MESH_HOME="${MESH_HOME:-$HOME/.mesh}"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/mesh-node.js" "$@"
    SH
  end

  def caveats
    <<~EOS
      Link this Mac to your wallet (the code comes from the web app: Run a node -> Link a Mac):
        mesh-node setup --link <code> --gateway https://<gateway-host>
        mesh-node service install        # background service via launchd, starts at login

      Ollama is installed by `mesh-node setup` if missing (brew install ollama). Apple Silicon only.
      Upgrade with `brew upgrade mesh-node`; `mesh-node update` is for the curl/tarball install.
      State lives in ~/.mesh (config.json, logs/). The agent never writes prompts or replies to disk.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mesh-node --version")
    assert_match "mesh-node setup", shell_output("#{bin}/mesh-node --help")
  end
end
