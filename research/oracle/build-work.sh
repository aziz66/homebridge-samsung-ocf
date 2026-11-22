#!/usr/bin/env bash
# Rebuild the standalone, Home-Assistant-free import tree gen_oracle.py needs,
# from a clone of mbillow/localthings placed next to this repo (../localthings-upstream
# or given as \$1). The registry subtree is HA-free except a few leaf modules,
# which are copied alongside empty __init__.py shims so importing the registry
# never triggers the HA-importing package __init__.
set -euo pipefail
SRC="${1:-../localthings-upstream}/custom_components/localthings"
[ -d "$SRC" ] || { echo "localthings source not found at $SRC"; exit 1; }
cd "$(dirname "$0")"
rm -rf work && mkdir -p work/custom_components/localthings/translations
touch work/custom_components/__init__.py work/custom_components/localthings/__init__.py
cp -r "$SRC/registry" work/custom_components/localthings/registry
for m in catalog const finish cloudcourse tvapps; do cp "$SRC/$m.py" work/custom_components/localthings/; done
cp "$SRC/translations/en.json" work/custom_components/localthings/translations/en.json
echo "work/ tree rebuilt from $SRC"
