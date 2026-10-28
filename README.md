# Rift Lens

A local Next.js League of Legends coach: a post-game replay review for any champion, plus a live second-screen coach. It connects directly to the reusable ROFL parser in this workspace.

## Start

Double-click `Launch Rift Lens.bat`, or run:

```powershell
npm run dev
```

Then open `http://localhost:3000`.

Open `http://localhost:3000/live` on a second monitor for the live-game view.

## Included

- Drag-and-drop `.rofl` uploads
- Instant metadata summaries or deep packet analysis
- Viktor and Lux performance cards
- Verified queue/game-mode detection through the local League client
- Mode-specific economy grading for Swiftplay, standard Summoner's Rift, ARAM, and fallback cases
- Match-specific build verdicts on hover
- Spell-conversion and duo follow-up visualization
- Interactive match timeline with Strong, Partial, and Improve moments
- Per-moment level, XP, total gold, current gold, CS, lane delta, and team-gold context
- Per-event explanations: what happened, why it mattered, and the better play
- One-click seeking to the selected moment in an open League replay
- Bot-lane damage, farm, and structure comparisons
- Priority coaching plan
- Cached deep analysis for instant repeat reviews
- On-demand Codex coaching through your saved ChatGPT login—no API key required
- Disk-cached AI responses keyed to the exact replay data; repeat views do not spend credits
- A live second-screen dashboard using Riot's local Live Client Data API
- Automatic, no-AI build choices based on visible teams, items, KDA, levels, CS, and current gold
- Enemy threat ranking, direct-matchup context, visible inventories, and measured death-source history
- A prominent **HELP ME** action that runs Codex only when clicked and caches the result by game state

Uploaded working copies are removed after parsing. The source replay is not changed. Deep decoding currently needs a matching replay-patch profile; quick summaries remain available when a new patch arrives.

For the most accurate review, leave the League client open while uploading. Rift Lens uses its local match-history feed to verify the queue and load one-minute timeline frames. If the client is closed or the match is unavailable, the page labels the mode as unknown and disables fixed economy verdicts instead of assuming normal Summoner's Rift.

## Optional AI coaching

Rift Lens never runs AI during upload or parsing. After a replay is ready, press **Analyze with AI** to request one structured Codex review. The local server verifies that Codex is signed in with ChatGPT, removes API-key environment variables from the child process, and runs an efficient low-reasoning review in a read-only, ephemeral session.

The response is saved under the memory folder's `ai-cache/review` (see Long-term memory). Re-uploading the same replay with the same extracted evidence loads that response without another model call. **Regenerate** is the only action that deliberately replaces the cached response and it asks for confirmation first.

Live HELP ME responses are stored separately in `ai-cache/live`. The always-on live dashboard is deterministic and does not call a model. Rift Lens reads only Riot's HTTPS endpoint at `127.0.0.1:2999`; it does not inspect League process memory. Riot's live feed does not expose a reliable damage-received-by-source breakdown, so damage profiles and threat labels are explicitly shown as inferences.

### Using Gemini CLI instead of Codex

Rift Lens can send every AI call (HELP ME, replay reviews, build research) to Google's Gemini CLI, signed in with a Google account (free tier, no API key):

1. Install it: `npm install -g @google/gemini-cli`
2. Run `gemini` once in a terminal, choose **Login with Google** and finish the browser sign-in, then exit.
3. Pick the provider: add `RIFT_LENS_AI_PROVIDER=gemini` to `.env.local` (restart Rift Lens), or switch **AI provider** in the live coach's settings menu (saved in the memory folder as `ai-settings.json`; it overrides the env var). Codex stays the default.

Rift Lens runs `gemini -p` headless with the prompt on stdin, removes `GEMINI_API_KEY`/`GOOGLE_API_KEY` from the child process, disables extensions, MCP servers and local file/shell tools, and allows only Google web search (plus page fetches) for build research. Gemini has no output-schema flag, so the JSON schema goes in the prompt and the reply is checked (one retry when it does not fit). Quick in-game reads use the `flash` model; everything else uses the CLI's default. Override with `RIFT_LENS_GEMINI_MODEL` / `RIFT_LENS_GEMINI_MODEL_FAST`, and point `RIFT_LENS_GEMINI_PATH` at the CLI's `dist/index.js` if it is installed somewhere unusual. The settings menu shows whether the chosen CLI is signed in.

## Long-term memory

While `/live` is open, every match is recorded to `work/rift-lens-memory/games/` (purchases, deaths with killer and unspent gold, CS at 10, completed-item order, result). After each game the profile is rebuilt: usual build paths and win rates per champion, boots, lane matchups, top killers, and recurring issues such as deaths holding 1000g+ or low CS at 10. Results come from Riot's `GameEnd` event, or from the League client if the feed closes first.

The live engine reads a compact brief of that profile on every poll. Your usual build becomes the default recommendation, deviations are labelled as deviations, and HELP ME cites your history. Open `/profile` (**Memory**) to review it, set a focus with a measurable target, and add notes or preferred/avoided items per champion. On a replay's AI review, **Track in live games** turns a priority into the live focus.

## Live coach

- **Death coach**: while you are dead, a respawn countdown, who killed you and why (measured or inferred), and exactly what your gold buys now. With auto coach on, a fast AI death read runs once per death.
- **Game plan**: in the first 90 seconds, one pregame AI read covers the lane, the enemy team and your history.
- **HELP ME**: fast mode (low reasoning) by default; **Deep read** uses medium reasoning. Answers are cached per game state.
- **Alerts**: objective spawns at 60s/30s/up, soul point, enemy level 6/11/16, enemy item completions, affordable next component, and the 10:00 focus checkpoint. Voice callouts are optional (off by default).
- **Objective timers** are derived from kill events. Grubs, Herald and Atakhan timings are best-effort and labelled.
- **Glance layout**: the main view answers three things in large type: what to buy next (with a gold bar and BUY NOW), the one thing to do right now, and up to two "doing well" / "fix this" calls. It switches to a game plan at the loading screen, a full death coach while you are dead, and a recap at game end. Everything else (enemy cards, stats, memory, event feed, deep read, build editor) is in **Details**.
- **Your build first**: the build path comes from a pinned build, then a captured Mobalytics / League-client item set, then your recorded games, then your current components. The AI may change part of it when the enemy team calls for it, and those cards are tagged **Changes your build**.
- **No sell-and-rebuy**: Rift Lens never suggests selling a component of the item you're buying (the shop already uses it), an item on your build path, or your boots, and it drops any AI pick that does.
- **AI power** (gear menu): Quick / Strong (default) / Max sets the reasoning level for in-game reads and the deep read.
- **Swiftplay aware**: Baron 12:00, Elder 15:00, two drakes for soul, no grubs or herald, and no normal-SR CS benchmarks.
- Settings are in the gear menu in the top bar.

Test without a match: `/live?mock=pregame`, `/live?mock=mid`, `/live?mock=dead`. AI never runs automatically in mock mode.

Optional environment variables: `RIFT_LENS_REPLAY_WORKSPACE` (folder holding `work/rofllens` and `outputs/League Replay Reviewer`; put it in `.env.local` when Rift Lens is not inside that folder), `RIFT_LENS_AI_MODEL_FAST`, `RIFT_LENS_AI_REASONING_FAST` (default `low`), `RIFT_LENS_AI_LEAN=0` (disable the lean Codex flags if HELP ME errors), `RIFT_LENS_MEMORY_DIR`, `RIFT_LENS_LOL_DIR`.

## Replay reader

Replay uploads run the separate ROFL reviewer (`reviewer.py` + its `work/rofllens` Python environment) found via `RIFT_LENS_REPLAY_WORKSPACE`. Rift Lens passes `--player <Riot ID>` (from the League client) and `--champions <most played>` so the uploader is reviewed on any champion. A reviewer that predates this needs `scripts/reviewer-player-patch.py` applied once: `<venv python> scripts/reviewer-player-patch.py "<workspace>/outputs/League Replay Reviewer/reviewer.py"`. Deep (spell-sequence) decoding still needs a decoder profile for the replay's patch; without one the quick review is returned.

After the reader runs, Rift Lens adds its own review (`lib/replay-enrich.ts`): item and rune names, all ten players' final items from the `.rofl`, a build check per reviewed player against the top build, champion scaling, exclusive item groups and the enemy team's items (`lib/replay-build-review.ts`), and, when the same match was recorded live (same champion, start within 3 min via the game id in the file name), its purchase order and deaths (`lib/replay-recorded.ts`). In development every analysis is saved to `.rift-lens/analyses/`; reopen one with `/?analysis=EUW1-1234567890`.

## Watch a timeline moment in League

The website can control a replay that is already open in the League client. This is a one-time setup:

1. Open `League of Legends/Config/game.cfg`.
2. Under `[General]`, add `EnableReplayApi=1`.
3. Start or restart the same `.rofl` replay in League.
4. Select a timeline event and click **View in League**.

Rift Lens seeks to three seconds before the event and starts playback. If the replay is not available, the website shows the setup steps without changing the League installation.
