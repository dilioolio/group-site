/* scenes.js — paints layered "misty mountain" SVG art into [data-scene] elements.
   Usage: <div class="scene" data-scene="dawn" data-seed="3"></div>
   Palettes: dawn | day | dusk | forest | night  (default: day) */
(function () {
  var UID = 0;

  var PALETTES = {
    dawn:   { sky: ["#F6D8B4", "#F0C2C0", "#E9D9D2"], sun: "#F4A65A", sunY: 70,
              ridges: ["#C9B7C9", "#A693AE", "#7E6E86", "#564E63", "#39354A"] },
    day:    { sky: ["#BFD9E0", "#D8E6E2", "#EEF2E8"], sun: null,
              ridges: ["#A9C2C2", "#86A89E", "#5F8576", "#3E6650", "#274836"] },
    dusk:   { sky: ["#EBA968", "#C98268", "#7C6385"], sun: "#E8693C", sunY: 74,
              ridges: ["#B98C77", "#8A6A74", "#5E5570", "#3C3F58", "#262A40"] },
    forest: { sky: ["#D8E6CF", "#E6EDDB", "#F2F3E8"], sun: null,
              ridges: ["#AEC6A0", "#84A579", "#5C8556", "#3C6740", "#26472C"] },
    night:  { sky: ["#2C3B52", "#3A4A60", "#566077"], sun: "#EAE6D8", sunY: 60,
              ridges: ["#46566B", "#39485C", "#2C384A", "#1F2838", "#161D2A"] }
  };

  // deterministic PRNG
  function rng(seed) {
    var s = seed * 9301 + 49297;
    return function () { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  }

  function ridgePath(rand, baseY, amp, rough, w, h) {
    var pts = [], n = 7, jitter = 0;
    for (var i = 0; i <= n; i++) {
      var x = (w / n) * i;
      jitter += (rand() - 0.5) * rough;
      // Clamp cumulative drift to the layer's amplitude so a streak of same-direction
      // random steps can't balloon the ridge into a single sweeping blob.
      if (jitter > amp) jitter = amp;
      else if (jitter < -amp) jitter = -amp;
      var y = baseY + Math.sin(i * 1.3 + rand() * 2) * amp * 0.4 + jitter - rand() * amp;
      pts.push([x, Math.max(6, y)]);
    }
    var d = "M" + (-10) + "," + h + " L" + (-10) + "," + pts[0][1].toFixed(1);
    for (var j = 0; j < pts.length; j++) {
      if (j === 0) { d += " L" + pts[j][0].toFixed(1) + "," + pts[j][1].toFixed(1); continue; }
      var p0 = pts[j - 1], p1 = pts[j], mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
      d += " Q" + p0[0].toFixed(1) + "," + p0[1].toFixed(1) + " " + mx.toFixed(1) + "," + my.toFixed(1);
    }
    d += " L" + (w + 10) + "," + pts[n][1].toFixed(1) + " L" + (w + 10) + "," + h + " Z";
    return d;
  }

  function build(el) {
    var name = el.getAttribute("data-scene") || "day";
    var pal = PALETTES[name] || PALETTES.day;
    var seed = parseInt(el.getAttribute("data-seed") || "1", 10) || 1;
    var rand = rng(seed * 7 + name.length);
    var W = 200, H = 120, id = "sc" + (++UID);

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid slice" aria-hidden="true">';
    svg += '<defs><linearGradient id="' + id + 'sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + pal.sky[0] + '"/>' +
      '<stop offset="0.55" stop-color="' + pal.sky[1] + '"/>' +
      '<stop offset="1" stop-color="' + pal.sky[2] + '"/></linearGradient>' +
      '<radialGradient id="' + id + 'sun" cx="0.5" cy="0.5" r="0.5">' +
      '<stop offset="0" stop-color="#fff" stop-opacity="0.9"/>' +
      '<stop offset="0.4" stop-color="' + (pal.sun || "#fff") + '" stop-opacity="0.95"/>' +
      '<stop offset="1" stop-color="' + (pal.sun || "#fff") + '" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="' + id + 'vig" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0.5" stop-color="#000" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#1b1f1a" stop-opacity="0.16"/></linearGradient></defs>';

    // sky
    svg += '<rect width="' + W + '" height="' + H + '" fill="url(#' + id + 'sky)"/>';
    // sun / moon glow
    if (pal.sun) {
      var sx = 40 + rand() * 120, sy = pal.sunY || 70;
      svg += '<circle cx="' + sx.toFixed(0) + '" cy="' + (H - sy) + '" r="46" fill="url(#' + id + 'sun)"/>';
      svg += '<circle cx="' + sx.toFixed(0) + '" cy="' + (H - sy) + '" r="11" fill="' + pal.sun + '" opacity="0.85"/>';
    }
    // mist band
    svg += '<rect y="' + (H * 0.52) + '" width="' + W + '" height="' + (H * 0.22) + '" fill="#ffffff" opacity="0.12"/>';

    // ridges back -> front
    var layers = pal.ridges.length;
    for (var k = 0; k < layers; k++) {
      var t = k / (layers - 1);
      var baseY = H * (0.30 + t * 0.52);
      var amp = 16 + t * 20;
      var rough = 10 + t * 16;
      var d = ridgePath(rand, baseY, amp, rough, W, H);
      svg += '<path d="' + d + '" fill="' + pal.ridges[k] + '" opacity="' + (0.9 + t * 0.1).toFixed(2) + '"/>';
      // mist veil between far ridges
      if (k < layers - 2) {
        svg += '<rect y="' + (baseY + 2) + '" width="' + W + '" height="14" fill="#ffffff" opacity="' + (0.14 - t * 0.04).toFixed(2) + '"/>';
      }
    }
    svg += '<rect width="' + W + '" height="' + H + '" fill="url(#' + id + 'vig)"/>';
    svg += '</svg>';
    el.insertAdjacentHTML("afterbegin", svg);
  }

  function init() {
    var els = document.querySelectorAll("[data-scene]");
    for (var i = 0; i < els.length; i++) {
      if (!els[i].__painted) { els[i].__painted = true; build(els[i]); }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.paintScenes = init;
})();
