# Rift Lens: setup (Windows)

A live League of Legends coach for your second screen. It runs on your own PC and reads Riot's local
game data. Nothing to enable in League.

## One time

1. **Node.js:** install the LTS version from https://nodejs.org (click Next through everything), then restart your PC.
2. **Git:** install from https://git-scm.com/download/win (click Next through everything).
3. **Download Rift Lens:** open the folder you want it in (e.g. Documents), click the address bar, type `cmd`, press Enter, then run:

   ```
   git clone https://github.com/NolzCoding/rift-lens.git
   ```

**Already have the old zip version?** Skip step 3: put the new `Launch Rift Lens.bat` in your old folder (replace the
old one) and double-click it. It turns that folder into an updating copy and copies your games and settings into its
`data` folder. Your old ones stay where they were as a backup.

## Every time

Double-click **`Launch Rift Lens.bat`** in the `rift-lens` folder. It downloads the newest version first (your `data`
folder is never touched), installs packages when needed, and opens the app. For the in-game coach go to
http://localhost:3000/live (second monitor, or `http://<your PC's IP>:3000/live` on your phone on the same Wi-Fi).

## AI (optional)

Everything important works without AI: what to buy next, the death-screen shop, counter items, timers, alerts.
AI adds the HELP ME button, a coach read when you die, and build research for new champions.

**Antigravity (Google account, e.g. a Google AI subscription):**

1. In **PowerShell** (not cmd): `irm https://antigravity.google/cli/install.ps1 | iex`
2. Open a new window, run `agy` once and sign in with Google in the browser it opens, then close it.
3. In Rift Lens open the settings (gear icon on the live page) and set **AI provider** to **Antigravity**.

Google replaced Gemini CLI with Antigravity CLI for personal Google accounts (free and Google AI Pro/Ultra) on
June 18, 2026, so the **Gemini** option only works with a company Gemini Code Assist license.

**Codex (ChatGPT account):** `npm install -g @openai/codex`, run `codex login`, and keep **AI provider** on **Codex**.

## Your data

Everything personal (your games, settings, researched builds, AI answers) is in the `data` folder inside `rift-lens`.
Updates never change it, and it is never uploaded anywhere.
