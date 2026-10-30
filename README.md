# Dibs

## Try it

Open the one-tab demo at [https://dibs.onrender.com](https://dibs.onrender.com) and click **▶ Run rehearsal**. Render's free web service sleeps when idle, so its first load can take about 30 seconds.

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
