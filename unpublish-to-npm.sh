#!/bin/bash
set -e

echo "Unpublishing pi-symdex from npm..."

# Check if logged in to npm
npm whoami || (echo "Please login to npm first: npm login" && exit 1)

# Get current version
CURRENT_VERSION=$(cat package.json | grep '"version"' | head -1 | awk -F: '{ print $2 }' | sed 's/[",]//g' | tr -d '[:space:]')
echo "Current version: $CURRENT_VERSION"

echo ""
echo "⚠️  WARNING: Unpublishing has strict limits:"
echo "   - Within 72h of publish: can unpublish (if no dependents)"
echo "   - After 72h: only if <300 downloads/week, no dependents, single owner"
echo "   - Once unpublished, that version can NEVER be republished"
echo ""

echo "Choose what to unpublish:"
echo "  1) Specific version only (e.g., $CURRENT_VERSION)"
echo "  2) Entire package (all versions)"
echo "  3) Cancel"
read -p "Enter choice (1-3): " choice

case $choice in
  1)
    read -p "Enter version to unpublish (default: $CURRENT_VERSION): " version
    version=${version:-$CURRENT_VERSION}
    echo "Unpublishing version: $version"
    npm unpublish "pi-symdex@$version"
    echo "✓ Version $version unpublished"
    ;;
  2)
    echo "⚠️  This will remove the ENTIRE package from npm!"
    read -p "Type the package name 'pi-symdex' to confirm: " confirm
    if [ "$confirm" = "pi-symdex" ]; then
      npm unpublish pi-symdex --force
      echo "✓ Package fully unpublished"
      echo "Note: You must wait 24 hours before republishing with the same name"
    else
      echo "Cancelled - confirmation did not match"
      exit 1
    fi
    ;;
  3)
    echo "Cancelled"
    exit 0
    ;;
  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

echo ""
echo "Done!"
