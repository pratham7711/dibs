const body = document.body;
const params = new URLSearchParams(location.search);
body.classList.remove("pos-br");
body.classList.add(
  `pos-${["br", "bl", "tr", "tl"].includes(params.get("pos")) ? params.get("pos") : "br"}`,
);

const elements = {
  ribbon: document.querySelector("#rehearsal-ribbon"),
  title: document.querySelector("#drop-title"),
  subtitle: document.querySelector("#drop-subtitle"),
  rows: document.querySelector("#spot-rows"),
  spotCount: document.querySelector("#spot-count"),
  waitCount: document.querySelector("#waitlist-count"),
  waitNames: document.querySelector("#waitlist-names"),
  reviewCount: document.querySelector("#review-count"),
  soldOut: document.querySelector("#sold-out"),
  countdown: document.querySelector("#subs-countdown"),
  countdownValue: document.querySelector("#countdown-value"),
  ring: document.querySelector("#ring-progress"),
};
let previousWaitlist = new Set();
let ringTimer;

function sourceLabel(claim) {
  if (claim.resolverSource === "model") return "🧠 gpt-oss";
  if (claim.resolverSource === "review") return "👀 review";
  return "⚡ rules";
}

function safeColor(color) {
  return /^#[0-9a-f]{6}$/i.test(color ?? "") ? color : "";
}

function makeSpot(index, claim, previous, promotedViewerId) {
  const row = document.createElement("div");
  const isPromoted = claim?.viewerId === promotedViewerId;
  row.className = `spot-row${claim ? " filled" : ""}${isPromoted ? " promoted" : ""}`;
  const number = document.createElement("span");
  number.className = "spot-number";
  number.textContent = String(index + 1).padStart(2, "0");
  row.append(number);

  const nameLine = document.createElement("span");
  nameLine.className = "viewer-line";
  const name = document.createElement("span");
  name.className = claim ? "viewer" : "empty-spot";
  name.textContent = claim?.display ?? "Open spot";
  const color = safeColor(claim?.chatColor);
  if (color) name.style.color = color;
  nameLine.append(name);
  if (isPromoted) {
    const moved = document.createElement("small");
    moved.className = "moved-label";
    moved.textContent = "↗ MOVED UP";
    nameLine.append(moved);
  }
  row.append(nameLine);

  if (claim) {
    const source = document.createElement("span");
    source.className = "source-chip";
    source.textContent = sourceLabel(claim);
    row.append(source);
    const gap = document.createElement("span");
    gap.className = "gap-chip";
    gap.textContent = previous
      ? `+${Math.max(0, (claim.twitchTimestamp - previous.twitchTimestamp) / 1000).toFixed(2)} s`
      : "FIRST";
    row.append(gap);
  }
  return row;
}

function startCountdown(drop, openedAt) {
  clearInterval(ringTimer);
  if (!drop?.subsFirstSeconds) {
    elements.countdown.hidden = true;
    return;
  }
  elements.countdown.hidden = false;
  const duration = drop.subsFirstSeconds;
  const circumference = 126;
  const update = () => {
    const remaining = Math.max(0, duration - (Date.now() - openedAt) / 1000);
    elements.countdownValue.textContent = String(Math.ceil(remaining));
    elements.ring.style.strokeDashoffset = String(
      circumference * (1 - remaining / duration),
    );
    if (remaining <= 0) {
      elements.countdown.hidden = true;
      clearInterval(ringTimer);
    }
  };
  update();
  ringTimer = setInterval(update, 100);
}

function render(view) {
  const state = view.snapshot;
  const drop = state.drop;
  elements.ribbon.hidden = view.mode !== "rehearsal";
  elements.title.textContent =
    drop?.title ??
    (view.mode === "rehearsal"
      ? "Rehearsal is warming up"
      : "Waiting for a drop");
  elements.subtitle.textContent = drop
    ? `${drop.spots} spots · First timestamp wins.`
    : "The race starts when the streamer opens spots.";
  const winners = [...(state.winners ?? [])].sort(
    (a, b) => a.twitchTimestamp - b.twitchTimestamp,
  );
  const spotTotal = drop?.spots ?? 0;
  const latestPromotion = [...(state.decisionLog ?? [])]
    .reverse()
    .find((decision) => decision.action === "promoted");
  const promotedViewerId =
    latestPromotion && Date.now() - latestPromotion.at < 2400
      ? latestPromotion.viewerId
      : undefined;
  elements.spotCount.textContent = `${winners.reduce((total, claim) => total + claim.qty, 0)} / ${spotTotal} CLAIMED`;
  elements.rows.replaceChildren();
  let rowIndex = 0;
  let previous;
  for (const claim of winners) {
    for (let unit = 0; unit < claim.qty && rowIndex < spotTotal; unit += 1) {
      elements.rows.append(
        makeSpot(rowIndex, claim, previous, promotedViewerId),
      );
      rowIndex += 1;
      previous = claim;
    }
  }
  while (rowIndex < spotTotal) {
    elements.rows.append(makeSpot(rowIndex, null));
    rowIndex += 1;
  }
  const total = winners.reduce((count, claim) => count + claim.qty, 0);
  elements.soldOut.hidden = !drop || total < drop.spots;
  const latestBump = [...(state.decisionLog ?? [])]
    .reverse()
    .find((decision) => decision.action === "displaced_to_waitlist");
  const bumpedViewerId =
    latestBump && Date.now() - latestBump.at < 2400
      ? latestBump.viewerId
      : undefined;
  const waitlist = [...(state.waitlist ?? [])].sort(
    (a, b) => a.twitchTimestamp - b.twitchTimestamp,
  );
  elements.waitCount.textContent = `${waitlist.length} waiting`;
  elements.waitNames.replaceChildren();
  if (waitlist.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty-list";
    empty.textContent = "Waiting for the next dibs…";
    elements.waitNames.append(empty);
  } else {
    for (const claim of waitlist.slice(0, 3)) {
      const name = document.createElement("span");
      const bumped = claim.viewerId === bumpedViewerId;
      name.className = `waiter${bumped ? " bumped" : previousWaitlist.has(claim.viewerId) ? "" : " moved"}`;
      name.textContent = bumped ? `${claim.display} · BUMPED` : claim.display;
      elements.waitNames.append(name);
    }
  }
  previousWaitlist = new Set(waitlist.map((claim) => claim.viewerId));
  elements.reviewCount.textContent = `${state.reviewQueue?.length ?? 0} in review`;
  if (drop && state.openedAt) startCountdown(drop, state.openedAt);
}

fetch("/api/state")
  .then((response) => response.json())
  .then(render)
  .catch(() => {});
const stream = new EventSource("/events");
stream.onmessage = (event) => render(JSON.parse(event.data));
