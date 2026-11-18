#!/bin/sh
cd "$(dirname "$0")" || exit 1
[ -d node_modules/three ] || npm install --omit=dev || exit 1
(sleep 1; open http://localhost:4321) &
exec node server.mjs
