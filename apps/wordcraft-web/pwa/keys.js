// Keep Safari (iPadOS) from using Tab and Cmd/Ctrl shortcuts for itself; the app handles them.
// Copy, cut and paste are left alone: they need the browser's own clipboard events.
// Tab is also queued for the app (wpDrainKeys). iPadOS marks keystrokes as "composing" while its
// hidden text input is active, and the web framework ignores those, so Tab is taken here even then.
// wpRepaint (set by the app) wakes the app at once so the queued key is applied without delay.
(function () {
  var clipboard = { c: 1, x: 1, v: 1 };
  var queue = [];
  function wake() { if (window.wpRepaint) { try { window.wpRepaint(); } catch (e) {} } }
  window.wpDrainKeys = function () { var q = queue; queue = []; return q; };
  window.addEventListener("keydown", function (e) {
    var key = (e.key || "").toLowerCase();
    var mod = e.metaKey || e.ctrlKey;
    if (key === "tab" || e.code === "Tab") {
      e.preventDefault();
      if (!mod && !e.altKey) {
        queue.push(e.shiftKey ? "BackTab" : "Tab");
        if (queue.length > 8) { queue.shift(); }
        wake();
        setTimeout(wake, 30);
      }
      return;
    }
    if (e.isComposing) { return; }
    if ((mod && !clipboard[key]) || /^f(3|4|5|7|8|9|12)$/.test(key)) {
      e.preventDefault();
    }
  }, true);
})();
