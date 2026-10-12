// Keep Safari (iPadOS) from using Tab and Cmd/Ctrl shortcuts for itself; the app handles them.
// Copy, cut and paste are left alone: they need the browser's own clipboard events.
(function () {
  var clipboard = { c: 1, x: 1, v: 1 };
  window.addEventListener("keydown", function (e) {
    if (e.isComposing) { return; }
    var key = (e.key || "").toLowerCase();
    var mod = e.metaKey || e.ctrlKey;
    if (key === "tab" || (mod && !clipboard[key]) || /^f(3|4|5|7|8|9|12)$/.test(key)) {
      e.preventDefault();
    }
  }, true);
})();
