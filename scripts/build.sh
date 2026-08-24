#!/bin/bash


# @dsh-external/dsh-arb-bucket build: junction-link host runtime packages + tsc compile.


# Host deps come from the installed DSH app's node_modules (no source checkout needed).


# Override location with APP_NODE_MODULES when the app lives elsewhere.


set -euo pipefail





ROOT="$(cd "$(dirname "$0")/.." && pwd)"


cd "$ROOT"





APP_NM="${APP_NODE_MODULES:-$(cd "$ROOT/../../resources/app/node_modules" 2>/dev/null && pwd || true)}"


if [ -z "${APP_NM:-}" ] || [ ! -d "$APP_NM/@deepseek-ai/cordis" ]; then


  echo "build: host node_modules not found (set APP_NODE_MODULES to the DSH app node_modules)" >&2


  exit 1


fi





link_pkg() {


  local link="node_modules/$1"


  local target="$APP_NM/$1"


  if [ ! -d "$target" ]; then


    echo "build: dependency target missing: $target" >&2


    exit 1


  fi


  node -e "


    const fs = require('fs');


    const path = require('path');


    const link = path.resolve(process.argv[1]);


    const target = path.resolve(process.argv[2]);


    fs.rmSync(link, { recursive: true, force: true });


    fs.mkdirSync(path.dirname(link), { recursive: true });


    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');


  " "$link" "$target"


}





echo "=== Linking build deps (host: $APP_NM) ==="


link_pkg "@deepseek-ai/cordis"


link_pkg "@deepseek-ai/schemastery"


link_pkg "@deepseek-ai/dsh-settings"







echo "=== Compiling src -> lib (tsc) ==="


node_modules/.bin/tsc -p tsconfig.json


echo "=== Host build complete ==="
