/*
 * Tiny PDF writer for receipts: A4 pages, Helvetica / Helvetica-Bold (built into every PDF viewer),
 * text, filled rectangles and lines. No dependencies, no network, CSP-safe.
 * Coordinates are in points from the TOP-left corner of the page (converted internally).
 * Text uses WinAnsiEncoding: Latin-1 plus a few typographic marks; anything else becomes "?".
 * Works in the browser (window.Merch.pdf) and in Node (module.exports) for tests.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Merch = root.Merch || {}; root.Merch.pdf = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAGE_W = 595.28;
  var PAGE_H = 841.89;

  // Glyph widths (1/1000 em) for character codes 32..126, from the standard Helvetica AFM files.
  var W_REGULAR = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,
    278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,
    667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,
    500,722,500,500,500,334,260,334,584];
  var W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,
    333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,
    667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,
    556,778,556,556,500,389,280,389,584];

  // Unicode -> WinAnsi byte for the characters outside Latin-1 that WinAnsi supports.
  var WIN_ANSI_EXTRA = {
    0x20AC: 128, 0x201A: 130, 0x0192: 131, 0x201E: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135, 0x02C6: 136, 0x2030: 137,
    0x0160: 138, 0x2039: 139, 0x0152: 140, 0x017D: 142, 0x2018: 145, 0x2019: 146, 0x201C: 147, 0x201D: 148, 0x2022: 149,
    0x2013: 150, 0x2014: 151, 0x02DC: 152, 0x2122: 153, 0x0161: 154, 0x203A: 155, 0x0153: 156, 0x017E: 158, 0x0178: 159
  };

  /** String -> array of WinAnsi byte values (unsupported characters become '?'). The rupee sign becomes "Rs.". */
  function encode(str) {
    var out = [];
    var s = String(str == null ? '' : str).replace(/₹\s?/g, 'Rs. ').replace(/[\r\n\t]+/g, ' ');
    for (var i = 0; i < s.length; i++) {
      var cp = s.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp >= 32 && cp <= 126) out.push(cp);
      else if (cp >= 160 && cp <= 255) out.push(cp);
      else if (WIN_ANSI_EXTRA[cp]) out.push(WIN_ANSI_EXTRA[cp]);
      else out.push(63); // '?'
    }
    return out;
  }

  function glyphWidth(code, bold) {
    var table = bold ? W_BOLD : W_REGULAR;
    if (code >= 32 && code <= 126) return table[code - 32];
    return 556; // close enough for the few accented letters and marks
  }

  /** Width of `str` in points at `size`. */
  function textWidth(str, size, bold) {
    var bytes = encode(str);
    var w = 0;
    for (var i = 0; i < bytes.length; i++) w += glyphWidth(bytes[i], bold);
    return (w * size) / 1000;
  }

  /** PDF literal string body (ASCII only: bytes >= 128 as octal escapes). */
  function literal(str) {
    var bytes = encode(str);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b === 40 || b === 41 || b === 92) out += '\\' + String.fromCharCode(b);
      else if (b >= 128) out += '\\' + ('00' + b.toString(8)).slice(-3);
      else out += String.fromCharCode(b);
    }
    return out;
  }

  function num(n) {
    return (Math.round(n * 100) / 100).toString();
  }

  function rgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#000000'));
    var v = m ? parseInt(m[1], 16) : 0;
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map(function (c) { return num(c); }).join(' ');
  }

  /** Splits text into lines no wider than maxWidth (breaks long words if needed). */
  function wrap(str, maxWidth, size, bold) {
    var words = String(str == null ? '' : str).split(/\s+/).filter(Boolean);
    var lines = [];
    var line = '';
    words.forEach(function (word) {
      var candidate = line ? line + ' ' + word : word;
      if (textWidth(candidate, size, bold) <= maxWidth) { line = candidate; return; }
      if (line) lines.push(line);
      line = word;
      while (textWidth(line, size, bold) > maxWidth && line.length > 1) {
        var cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    });
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  function create(opts) {
    opts = opts || {};
    var pages = [];
    var ops = null;

    function page() {
      ops = [];
      pages.push(ops);
      return api;
    }

    function y(top) { return num(PAGE_H - top); }

    var api = {
      width: PAGE_W,
      height: PAGE_H,
      page: page,
      pageCount: function () { return pages.length; },
      textWidth: textWidth,
      wrap: wrap,
      /** text(str, x, top, { size, bold, color, align: 'left'|'right'|'center' }); `top` is the baseline. */
      text: function (str, x, top, o) {
        o = o || {};
        var size = o.size || 10;
        var w = textWidth(str, size, o.bold);
        var left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
        ops.push('BT ' + rgb(o.color) + ' rg /' + (o.bold ? 'F2' : 'F1') + ' ' + num(size) + ' Tf ' + num(left) + ' ' + y(top) +
          ' Td (' + literal(str) + ') Tj ET');
        return api;
      },
      rect: function (x, top, w, h, color) {
        ops.push(rgb(color) + ' rg ' + num(x) + ' ' + y(top + h) + ' ' + num(w) + ' ' + num(h) + ' re f');
        return api;
      },
      line: function (x1, top1, x2, top2, color, width) {
        ops.push(num(width || 0.75) + ' w ' + rgb(color) + ' RG ' + num(x1) + ' ' + y(top1) + ' m ' + num(x2) + ' ' + y(top2) + ' l S');
        return api;
      },
      /** -> the whole PDF as an ASCII string (safe to put in a Blob as-is). */
      output: function () {
        if (!pages.length) page();
        var objects = [];
        var add = function (body) { objects.push(body); return objects.length; };
        var catalog = add(null);
        var pagesObj = add(null);
        var f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
        var f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
        var kids = pages.map(function (p) {
          var stream = p.join('\n');
          var contents = add('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
          return add('<< /Type /Page /Parent ' + pagesObj + ' 0 R /MediaBox [0 0 ' + num(PAGE_W) + ' ' + num(PAGE_H) + '] ' +
            '/Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >> >> /Contents ' + contents + ' 0 R >>');
        });
        objects[catalog - 1] = '<< /Type /Catalog /Pages ' + pagesObj + ' 0 R >>';
        objects[pagesObj - 1] = '<< /Type /Pages /Kids [' + kids.map(function (k) { return k + ' 0 R'; }).join(' ') + '] /Count ' + kids.length + ' >>';
        var info = add('<< /Title (' + literal(opts.title || 'Receipt') + ') /Producer (Merch Store) >>');

        var out = '%PDF-1.4\n';
        var offsets = [];
        objects.forEach(function (body, i) {
          offsets.push(out.length);
          out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
        });
        var xref = out.length;
        out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
        offsets.forEach(function (o) { out += ('0000000000' + o).slice(-10) + ' 00000 n \n'; });
        out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalog + ' 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
        return out;
      }
    };
    return api;
  }

  return { create: create, textWidth: textWidth, wrap: wrap, encode: encode, PAGE_W: PAGE_W, PAGE_H: PAGE_H };
});
