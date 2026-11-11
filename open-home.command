#!/bin/zsh
# Opens the linked computer's own Mission Control pages in the browser on this Mac. Double-click it in Finder, or run it
# in Terminal. Its projects already show in this Mac's project tree; this is for the rest of its pages.
#
# This Mac's Mission Control runs the link to that computer itself (server/services/pcLink.js, with the pairing in .data/home-link),
# so this asks it for a one-use enter address and opens that: it gives the browser the link's cookie. Each address works
# once, within a minute. That computer must be on: when it is off, the page says it cannot reach the PC.

cd "${0:A:h}" || exit 1
API=http://127.0.0.1:1700

fail() {
  echo "$1"
  read -k1 "?Press any key to close."
  exit 1
}

curl -fs -m 2 -o /dev/null "$API/api/health" || fail "Mission Control is not running on this Mac. Start it first (start-mac.command), then try again."
answer=$(curl -s -m 15 -X POST -H "X-MC: 1" -H "Content-Type: application/json" -d '{}' "$API/api/pc-link/enter")
url=$(print -r -- "$answer" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
# 127.0.0.1, never localhost: the link refuses any other host name.
case $url in
  http://127.0.0.1:*/__mc/enter\?t=*) open "$url"; echo "Opened the linked computer's Mission Control in the browser." ;;
  *) fail "The link to the other computer gave no address: $(print -r -- "$answer" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')" ;;
esac
