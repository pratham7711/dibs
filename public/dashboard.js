const elements = {
  banner: document.querySelector("#rehearsal-banner"),
  twitch: document.querySelector("#twitch-status"),
  model: document.querySelector("#model-status"),
  form: document.querySelector("#drop-form"),
  title: document.querySelector("#title"),
  spots: document.querySelector("#spots"),
  limit: document.querySelector("#limit"),
  subs: document.querySelector("#subs"),
  open: document.querySelector("#open-drop"),
  close: document.querySelector("#close-drop"),
  undo: document.querySelector("#undo"),
  rehearsal: document.querySelector("#start-rehearsal"),
  dropState: document.querySelector("#drop-state"),
  feed: document.querySelector("#feed"),
  feedCount: document.querySelector("#feed-count"),
  reviews: document.querySelector("#review-list"),
  reviewCount: document.querySelector("#review-count"),
  winners: document.querySelector("#winner-list"),
  winnerCount: document.querySelector("#winner-count"),
  waitlist: document.querySelector("#dashboard-waitlist"),
  waitCount: document.querySelector("#waitlist-count"),
  overlayUrl: document.querySelector("#overlay-url"),
  copy: document.querySelector("#copy-overlay"),
  toast: document.querySelector("#toast"),
};
const room = new URLSearchParams(location.search).get("room");
const roomQuery = room ? `?room=${encodeURIComponent(room)}` : "";
let currentView;
let selectedReview = 0;
let toastTimer;
const overlayUrl = `${location.origin}/overlay?pos=br${room ? `&room=${encodeURIComponent(room)}` : ""}`;
elements.overlayUrl.textContent = overlayUrl;
document.querySelector("#overlay-link").href =
  `/overlay?pos=br${room ? `&room=${encodeURIComponent(room)}` : ""}`;
document.querySelector(".csv-link").href = `/api/drop/winners.csv${roomQuery}`;
document.querySelector(".wordmark").href = `/dashboard${roomQuery}`;

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

async function api(path, body = {}) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(
    `${path}${room ? `${separator}room=${encodeURIComponent(room)}` : ""}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function decisionLabel(action) {
  return (
    {
      granted: "GRANTED",
      granted_by_timestamp: "EARLIER TIMESTAMP",
      displaced_to_waitlist: "MOVED TO WAITLIST",
      waitlisted: "WAITLISTED",
      promoted: "MOVED UP",
      needs_review: "REVIEW",
      duplicate_ignored: "DUPLICATE",
      limit_reached: "LIMIT REACHED",
      cancelled: "CANCELLED",
      removed: "REMOVED",
      question: "QUESTION",
      other: "CHAT",
      ignored: "NOT A CLAIM",
      undone: "UNDONE",
    }[action] ?? action.toUpperCase().replaceAll("_", " ")
  );
}

function renderFeed(feed) {
  elements.feedCount.textContent = `${feed.length} messages`;
  elements.feed.replaceChildren();
  if (!feed.length) {
    const empty = node("div", "empty-state");
    empty.append(
      node("span", "", "✳"),
      node("b", "", "Quiet for now."),
      node("p", "", "Open a drop and the first dibs will land here."),
    );
    elements.feed.append(empty);
    return;
  }
  for (const item of [...feed].reverse()) {
    const row = node("article", "feed-item");
    const avatar = node(
      "div",
      "feed-avatar",
      item.display.slice(0, 1).toUpperCase(),
    );
    if (/^#[0-9a-f]{6}$/i.test(item.color ?? ""))
      avatar.style.background = item.color;
    const copy = node("div", "feed-copy");
    const line = node("div", "feed-topline");
    line.append(
      node("span", "feed-name", item.display),
      node(`span`, `chip ${item.action}`, decisionLabel(item.action)),
      node(
        "span",
        "feed-source",
        item.source === "model"
          ? "🧠 model"
          : item.source === "review"
            ? "👀 review"
            : "⚡ rules",
      ),
    );
    copy.append(
      line,
      node("div", "feed-message", item.text),
      node("div", "feed-why", item.why),
    );
    const time = node(
      "time",
      "feed-time",
      new Date(item.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
    row.append(avatar, copy, time);
    elements.feed.append(row);
  }
}

function renderReviews(queue) {
  elements.reviewCount.textContent = String(queue.length);
  elements.reviews.replaceChildren();
  if (!queue.length) {
    const empty = node("div", "empty-state short");
    empty.append(
      node("b", "", "Nothing in review."),
      node(
        "p",
        "",
        "Unclear intent waits here. It never gets a spot automatically.",
      ),
    );
    elements.reviews.append(empty);
    selectedReview = 0;
    return;
  }
  selectedReview = Math.min(selectedReview, queue.length - 1);
  queue.forEach((claim, index) => {
    const card = node(
      "article",
      `review-card${index === selectedReview ? " selected" : ""}`,
    );
    card.tabIndex = 0;
    card.addEventListener("click", () => {
      selectedReview = index;
      render(currentView);
    });
    const meta = node("div", "review-meta");
    meta.append(
      node("span", "", `${claim.display} · ${claim.login}`),
      node("span", "", `#${index + 1}`),
    );
    const actions = node("div", "review-actions");
    const approve = node("button", "approve", "A · Approve");
    approve.addEventListener("click", () =>
      actOnReview(claim.messageId, "approve"),
    );
    const reject = node("button", "", "R · Reject");
    reject.addEventListener("click", () =>
      actOnReview(claim.messageId, "reject"),
    );
    actions.append(approve, reject);
    const activity = currentView.feed.find(
      (item) => item.messageId === claim.messageId,
    );
    card.append(
      meta,
      node(
        "div",
        "review-message",
        `“${activity?.text ?? "Claim needs review"}”`,
      ),
      node("div", "review-why", claim.reason),
      actions,
    );
    elements.reviews.append(card);
  });
}

async function actOnReview(messageId, action) {
  try {
    await api(`/api/review/${encodeURIComponent(messageId)}/${action}`);
    toast(action === "approve" ? "Claim approved." : "Claim rejected.");
  } catch (error) {
    toast(error.message);
  }
}

function renderRoster(snapshot, rehearsal = false) {
  const winners = [...snapshot.winners].sort(
    (a, b) => a.twitchTimestamp - b.twitchTimestamp,
  );
  elements.winnerCount.textContent = String(
    winners.reduce((total, item) => total + item.qty, 0),
  );
  elements.winners.replaceChildren();
  if (!winners.length)
    elements.winners.append(
      node("div", "empty-roster", "No spots claimed yet."),
    );
  winners.forEach((claim, index) => {
    const row = node("div", "roster-row");
    row.append(
      node("span", "rank", String(index + 1).padStart(2, "0")),
      node("span", "roster-name", claim.display),
      node(
        "span",
        "roster-time",
        new Date(
          rehearsal ? claim.receivedAt : claim.twitchTimestamp,
        ).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      ),
    );
    const cancel = node("button", "cancel-button", "CANCEL");
    cancel.addEventListener("click", async () => {
      try {
        await api(`/api/claims/${encodeURIComponent(claim.messageId)}/cancel`);
        toast(`${claim.display} cancelled.`);
      } catch (error) {
        toast(error.message);
      }
    });
    row.append(cancel);
    elements.winners.append(row);
  });
  const waitlist = [...snapshot.waitlist].sort(
    (a, b) => a.twitchTimestamp - b.twitchTimestamp,
  );
  elements.waitCount.textContent = `${waitlist.length} in line`;
  elements.waitlist.replaceChildren();
  if (!waitlist.length)
    elements.waitlist.append(node("span", "muted", "The line is clear."));
  waitlist.forEach((claim) =>
    elements.waitlist.append(node("span", "dashboard-waiter", claim.display)),
  );
}

function render(view) {
  currentView = view;
  const snapshot = view.snapshot;
  elements.banner.hidden = view.mode !== "rehearsal";
  elements.twitch.className = `status${view.mode === "rehearsal" ? " rehearsal" : view.twitchConnected ? " connected" : ""}`;
  elements.twitch.querySelector("span").textContent =
    view.mode === "rehearsal"
      ? "Rehearsal stream"
      : view.twitchConnected
        ? "Twitch connected"
        : "Connecting to Twitch";
  elements.model.classList.toggle("ready", view.modelConfigured);
  elements.model.querySelector("b").textContent = view.modelConfigured
    ? "READY"
    : "NOT SET";
  const active = snapshot.drop?.status === "open";
  elements.dropState.textContent = active
    ? "DROP LIVE"
    : snapshot.drop
      ? "DROP CLOSED"
      : "NO ACTIVE DROP";
  elements.dropState.classList.toggle("open", active);
  elements.open.disabled = active;
  elements.close.disabled = !active;
  elements.undo.disabled = snapshot.decisionLog.length <= 1;
  renderFeed(view.feed);
  renderReviews(snapshot.reviewQueue);
  renderRoster(snapshot, view.mode === "rehearsal");
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/drop", {
      title: elements.title.value.trim(),
      spots: Number(elements.spots.value),
      perViewerLimit: Number(elements.limit.value),
      ...(Number(elements.subs.value) > 0
        ? { subsFirstSeconds: Number(elements.subs.value) }
        : {}),
    });
    toast("Drop is live. Let the race begin.");
  } catch (error) {
    toast(error.message);
  }
});
elements.close.addEventListener("click", async () => {
  try {
    await api("/api/drop/close");
    toast("Drop closed.");
  } catch (error) {
    toast(error.message);
  }
});
elements.undo.addEventListener("click", async () => {
  try {
    await api("/api/drop/undo");
    toast("Last decision undone.");
  } catch (error) {
    toast(error.message);
  }
});
elements.rehearsal.addEventListener("click", async () => {
  try {
    await api("/api/rehearsal/start");
    toast("Rehearsal crowd is on its way.");
  } catch (error) {
    toast(error.message);
  }
});
elements.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(overlayUrl);
  toast("Overlay URL copied.");
});

document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  const queue = currentView?.snapshot.reviewQueue ?? [];
  if (!queue.length) return;
  if (event.key.toLowerCase() === "j") {
    selectedReview = Math.min(queue.length - 1, selectedReview + 1);
    render(currentView);
  }
  if (event.key.toLowerCase() === "k") {
    selectedReview = Math.max(0, selectedReview - 1);
    render(currentView);
  }
  if (event.key.toLowerCase() === "a")
    actOnReview(queue[selectedReview].messageId, "approve");
  if (event.key.toLowerCase() === "r")
    actOnReview(queue[selectedReview].messageId, "reject");
});

fetch(`/api/state${roomQuery}`)
  .then((response) => response.json())
  .then(render)
  .catch(() => {});
const stream = new EventSource(`/events${roomQuery}`);
stream.onmessage = (event) => render(JSON.parse(event.data));
