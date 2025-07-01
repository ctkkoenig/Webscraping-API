#!/bin/bash
set -e

# Determine Puppeteer browser path if already installed, ignoring errors.
set +e
BROWSER_PATH=$(node - 2>/dev/null <<'NODE'
const puppeteer = require('puppeteer');
try {
  process.stdout.write(puppeteer.executablePath());
} catch {}
NODE
)
set -e

if [ ! -x "$BROWSER_PATH" ]; then
  echo "Installing Chrome for architecture $(uname -m)..."
  npx puppeteer browsers install chrome
  # Recalculate the browser path after installation
  BROWSER_PATH=$(node - <<'NODE'
const puppeteer = require('puppeteer');
process.stdout.write(puppeteer.executablePath());
NODE
  )
fi

# Export path so the app can launch Chrome
export PUPPETEER_EXECUTABLE_PATH="$BROWSER_PATH"

exec node dist/index.js
