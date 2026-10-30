# Dibs product brief

Dibs is a fair, first-come drop tool for Twitch chat. Streamers use it for giveaways with limited spots, viewer-game slots, merch drops, raffles, and similar moments. Chat messages such as “dibs”, “me!!”, “put me down for 2”, “slot 3 pls”, and “mujhe ek chahiye” should not require the streamer to manually reconstruct the queue.

## Product behavior

- Read chat with Twitch EventSub WebSocket `channel.chat.message`; reply through the Helix Send Chat Message API.
- Settle clear claims with deterministic rules in under a millisecond. Ambiguous messages may be classified by OpenAI open-weight gpt-oss-20b on Groq's free tier; unresolved messages enter a streamer review queue and are never auto-granted. A wrong grant costs more than asking.
- Order claims by EventSub `metadata.message_timestamp`, not arrival time. A short settle window lets a late-arriving earlier message displace a recent winner.
- Enforce one claim per viewer by default, configurable per drop. Maintain a waitlist that advances when a winner cancels (“nvm”, “cancel mine”, “drop me”) or the streamer rejects a winner.
- Treat Channel Points redemptions as claims.
- Record a short human-readable reason for every decision and export winners as CSV.

## Later product work

- OBS browser-source overlay showing the live race: spots filling, “+0.41 s” gaps, waitlist ticker, and a SOLD OUT burst.
- Streamer dashboard for creating and managing drops and reviewing ambiguous messages.
- Clearly labelled rehearsal mode that replays a scripted crowd.
- Twitch EventSub/Helix integration, OpenAI/Groq ambiguity resolution, and Channel Points integration.

## Fairness and safety rules

Twitch's message timestamp is authoritative for ordering. Duplicate Twitch messages cannot claim twice. A viewer is never granted beyond the configured per-viewer limit, and a drop never has more winners than spots. Questions, third-person statements, past-tense statements, and negated intent do not become claims. Ambiguous intent requires human review; it is not auto-granted. Every allocation, waitlist, cancellation, rejection, and promotion decision explains why it happened.
