# FriendsBar

FriendsBar is a Decky Loader plugin that shows your online Steam friends in the Steam Deck top bar, immediately to the left of the search icon.

## Features

- Displays online friends in the top bar with avatar + activity stripe:
  - Green solid: online and in-game
  - Green dotted: in-game and idle
  - Blue solid: online (not in-game)
  - Blue dotted: online idle (not in-game)
- Refreshes automatically every 60 seconds.
- Uses Steam Web API for more reliable status details.

## Setup

1. Open FriendsBar in Decky.
2. Select `Edit API key`.
3. Enter your Steam Web API key and save.
4. Get your key at: `https://steamcommunity.com/dev/apikey`

## Build

```bash
npm install
npm run build
```

## Local Install Package

Build output is bundled under:

- `release/FriendsBar/`
- zip packages like `FriendsBar-build-YYYY-MM-DD-HHMMSS-TZ.zip`
