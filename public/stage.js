const params = new URLSearchParams(location.search);
const position = ["br", "bl", "tr", "tl"].includes(params.get("overlay"))
  ? params.get("overlay")
  : "br";
const frame = document.querySelector("#overlay");
frame.classList.add(position);
const overlay = new URL("/overlay", location.origin);
overlay.searchParams.set("pos", position);
if (params.has("room")) overlay.searchParams.set("room", params.get("room"));
frame.src = overlay;
