// Keep Safari (iPadOS) from using Tab and Cmd/Ctrl shortcuts for itself; the app handles them.
// Copy, cut and paste are left alone: they need the browser's own clipboard events.
// Tab is also queued for the app (wpDrainKeys): on iPadOS the web framework can miss it, and the
// app uses the queue only when the framework did not deliver the key itself.
(function () {
  var clipboard = { c: 1, x: 1, v: 1 };
  var queue = [];
  window.wpDrainKeys = function () { var q = queue; queue = []; return q; };
  window.addEventListener("keydown", function (e) {
    if (e.isComposing) { return; }
    var key = (e.key || "").toLowerCase();
    var mod = e.metaKey || e.ctrlKey;
    if (key === "tab" && !mod && !e.altKey) {
      queue.push(e.shiftKey ? "BackTab" : "Tab");
      if (queue.length > 8) { queue.shift(); }
    }
    if (key === "tab" || (mod && !clipboard[key]) || /^f(3|4|5|7|8|9|12)$/.test(key)) {
      e.preventDefault();
    }
  }, true);
})();
