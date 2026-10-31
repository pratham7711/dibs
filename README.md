# Dibs

## Try it

Open the one-tab demo at [https://dibs-at23.onrender.com](https://dibs-at23.onrender.com) and click **▶ Run rehearsal**. Render's free web service sleeps when idle, so its first load can take about 30 seconds.

Dibs runs fair, first come drops for Twitch chat. It recognizes clear claims, orders them by Twitch's message timestamp, keeps unclear requests in a streamer review queue, and promotes waitlisted viewers when a winner cancels.

## Rehearse in 60 seconds

```sh
npm install && npm start
```

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard) and [http://localhost:3000/overlay?pos=br](http://localhost:3000/overlay?pos=br). With no Twitch credentials, the server opens an empty drop labeled **REHEARSAL** and waits. Click **▶ Run rehearsal** to watch the 32-second scripted crowd play through the real resolver and allocator. The script includes a fast claim burst, an earlier timestamp arriving late, questions, a Channel Points claim, review and approval, and two cancellations with promotions. You can also run the choreography directly with `npm run rehearsal`.

## Connect Twitch

1. Register a Twitch application at [dev.twitch.tv/console](https://dev.twitch.tv/console) and enable the Device Code grant.
2. Copy `.env.example` to `.env`; set `TWITCH_CLIENT_ID` and `TWITCH_CHANNEL` (the broadcaster login). Add `GROQ_API_KEY` for ambiguous-message model fallback; `PORT`, `DIBS_EVENTSUB_WS_URL`, and `DIBS_HELIX_URL` are optional overrides.
3. Run `npm run auth` and finish authorization in the browser. Dibs stores and refreshes tokens in `.dibs/tokens.json`.
4. Run `npm start`. Open the dashboard and add a drop. In OBS, add a Browser Source pointed at `http://localhost:3000/overlay?pos=br` (or `bl`, `tr`, `tl`), set it to 1920×1080, and enable transparency.

The authorized bot account needs chat read/write and Channel Points redemption read scopes. The broadcaster can use their own account as the bot.

## Model fallback

Clear claims and cancellations use local rules. Ambiguous messages are batched to the OpenAI-compatible Groq endpoint using `openai/gpt-oss-20b` when `GROQ_API_KEY` is configured. Set `DIBS_LLM_API_KEY`, `DIBS_LLM_BASE_URL`, or `DIBS_LLM_MODEL` to override provider settings. Without a key, ambiguous requests and third-party requests go to review and are never granted automatically. Questions and chatter stay out of the allocation.

## Architecture

- `src/core/` is a pure event-sourced allocator with ordering, settle-window, waitlist, and review decisions.
- `src/resolver/` applies fast deterministic rules first, then batches ambiguous messages to the model and validates its output.
- `src/twitch/` handles Device Code auth, EventSub WebSocket notifications, and Helix chat replies.
- `src/runtime.ts` connects the allocator, resolver, Twitch integrations, HTTP API, and SSE updates.
- `public/` contains the static dashboard and transparent OBS overlay. `src/rehearsal.ts` drives a fictional crowd through the same runtime.

## OBS stage

Add a browser source pointing to `http://localhost:3000/stage?overlay=br`. Use `overlay=bl`, `tr`, or `tl` to move the Dibs card.

## Checks

```sh
npm test
npx tsc --noEmit
```

## Built with Codex

- **Step 1:** Product brief, TypeScript/ESM project scaffold, event-sourced drop allocator, and deterministic claim rules.
- **Step 2:** Readable formatted code, ambiguity model fallback, batching, validation, and token budget guard.
- **Step 3:** Twitch Device Code auth, EventSub, chat replies, HTTP endpoints, and SSE state stream.
- **Step 4:** OBS race overlay, streamer dashboard, and initial rehearsal mode.
- **Step 5:** Replayable 32-second choreography, timestamp fairness and promotion visuals, Channel Points rehearsal claim, documentation, and polish.
- **Step 6:** One-tab hosted demo, isolated rehearsal rooms, public request limits, proxy-safe SSE, and process-wide model decision caching.
- **Step 7:** Ranked, name-bearing chat summaries; threaded `!spot` replies; throttled public status answers; and a timed sold-out announcement.
- **Step 8:** Grapheme-safe dashboard avatars, a standalone neon OBS stage, and a live practice crowd that competes in the allocator without exposing fictional names in Twitch chat.
- **Step 9:** Transparent overlay iframe on `/stage`, keeping the arena visible behind the race card.
- **Step 10:** Public room redirects preserve existing query parameters, including stage overlay position.
- **Step 11 (753f958):** Live-channel fixes: keepalive grace for Twitch's 9.99–10.01 s keepalive cadence, replies threaded to chat message ids with a no-parent retry on HTTP 400, and bot self-reply filtering.
- **Step 12 (b22ff19):** Threaded replies omit Twitch's automatic duplicate `@mention`, and bot echoes stay out of the feed.
- **Step 13 (36dba49):** Suppressed practice-only chat lines, prioritized real answers over queued summaries, fit the overlay card for 1–20 spots, and aligned SOLD OUT waitlist counts with the overlay.
- **Step 14 (a0d348e):** Chat counts only practice winners and places that count beside the winners.

Steps 11–14 came from streaming to a real Twitch channel with OBS and checking what chat and the overlay showed.
