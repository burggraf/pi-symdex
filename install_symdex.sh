#!/bin/bash
set -e

echo "=== Installing symdex ==="

# Check if pipx is installed, install if not
if ! command -v pipx &> /dev/null; then
    echo "pipx not found. Installing pipx via Homebrew..."
    brew install pipx
    pipx ensurepath
    echo "Please restart your terminal or run: source ~/.zshrc (or ~/.bashrc)"
fi

# Install symdex using pipx
echo "Installing symdex with pipx..."
pipx install symdex

echo ""
echo "=== Installation complete! ==="
echo "symdex has been installed in its own isolated virtual environment."
echo "You can now use 'symdex' from the command line."
echo ""
echo "To upgrade in the future, run: pipx upgrade symdex"
echo "To uninstall, run: pipx uninstall symdex"
