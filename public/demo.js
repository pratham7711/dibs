const room = new URLSearchParams(location.search).get("room");
const query = `room=${encodeURIComponent(room ?? "")}`;
const overlayFrame = document.querySelector("#overlay-frame");
const streamFrame = document.querySelector(".stream-frame");
overlayFrame.src = `/overlay?pos=br&${query}`;
const fitOverlay = () => {
  overlayFrame.style.transform = `scale(${streamFrame.clientWidth / 1920})`;
};
new ResizeObserver(fitOverlay).observe(streamFrame);
fitOverlay();
document.querySelector("#dashboard-frame").src = `/dashboard?${query}`;
document
  .querySelector("#run-rehearsal")
  .addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "⏳ Starting…";
    try {
      const response = await fetch(`/api/rehearsal/start?${query}`, {
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error ?? "Could not start rehearsal.");
      button.textContent = "✓ Rehearsal running";
    } catch (error) {
      button.textContent = "▶ Run rehearsal";
      button.disabled = false;
      window.alert(error.message);
    }
  });
