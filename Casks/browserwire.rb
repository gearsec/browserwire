cask "browserwire" do
  version "0.1.0"

  if Hardware::CPU.arm?
    url "https://github.com/gearsec/browserwire/releases/download/v#{version}/BrowserWire-#{version}-arm64.dmg"
    sha256 "PLACEHOLDER"
  else
    url "https://github.com/gearsec/browserwire/releases/download/v#{version}/BrowserWire-#{version}-x64.dmg"
    sha256 "PLACEHOLDER"
  end

  name "BrowserWire"
  desc "Contract layer between AI agents and websites"
  homepage "https://github.com/gearsec/browserwire"

  app "BrowserWire.app"

  caveats <<~EOS
    browserwire is not signed with an Apple Developer certificate.
    You may need to install with:
      brew install --cask --no-quarantine browserwire
  EOS

  zap trash: "~/.browserwire"
end
