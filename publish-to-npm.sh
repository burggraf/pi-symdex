#!/bin/bash
set -e

echo "Publishing pi-symdex to npm..."

# Check if logged in to npm
npm whoami || (echo "Please login to npm first: npm login" && exit 1)

# Version check
echo "Current version:"
cat package.json | grep '"version"'

read -p "Enter new version (or press enter to keep current): " new_version

if [ ! -z "$new_version" ]; then
  npm version "$new_version" --no-git-tag-version
fi

# Publish
echo "Publishing..."
npm publish --access public

echo "Published successfully!"
