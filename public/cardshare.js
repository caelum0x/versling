// cardshare.js — shareable verse-image-card generator.
// Shared mechanism ported natively into shloka/versling/gatha/pasuk (each a
// separate repo/deployment, no runtime code sharing between them). Renders
// a verse (original-language text + English translation + this app's own
// mark/branding) to an HTML canvas client-side, then shares it via the Web
// Share API (with a real image file) or falls back to a plain download.
// No server round-trip, no paid API, no external fonts/fetches — safe
// under every app's existing CSP (`default-src 'self'`).
(() => {
  "use strict";

  const CARD_W = 1080;
  const CARD_H = 1350;

  // Wraps `text` onto multiple lines at `maxWidth` (in the ctx's current
  // font) and draws each line left-aligned (or right-aligned for RTL text,
  // handled by the caller via ctx.textAlign) starting at (x, y). Returns
  // the number of lines drawn so callers can advance y afterwards.
  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
      if (maxLines && lines.length >= maxLines) break;
    }
    if (line && (!maxLines || lines.length < maxLines)) lines.push(line);
    let shown = lines;
    if (maxLines && shown.length > maxLines) {
      shown = shown.slice(0, maxLines);
      shown[maxLines - 1] = shown[maxLines - 1].replace(/\s*\S*$/, "") + "…";
    }
    shown.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
    return shown.length;
  }

  // opts:
  //   originalText, originalFont ("400 56px ..."), originalDir ("ltr"|"rtl")
  //   translation, reference (e.g. "Chapter 9 Verse 1" / "Genesis 1:1"),
  //   chapterLabel (small tag above the hero text)
  //   appName, mark (short glyph/initial), domain (shown bottom-right)
  //   bg, fg, fgDim, accent (hex colors, from the app's own CSS variables)
  function renderVerseCard(opts) {
    const {
      originalText, originalFont, originalDir = "ltr",
      translation, reference, chapterLabel,
      appName, mark, domain,
      bg, fg, fgDim, accent,
    } = opts;

    const canvas = document.createElement("canvas");
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext("2d");

    // Background: solid app bg + a soft accent-colored glow in one corner
    // (subtle texture, not a flat placeholder rectangle).
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    const glow = ctx.createRadialGradient(
      CARD_W * 0.12, CARD_H * 0.1, 0,
      CARD_W * 0.12, CARD_H * 0.1, CARD_W * 0.75
    );
    glow.addColorStop(0, accent + "26");
    glow.addColorStop(1, accent + "00");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    const glow2 = ctx.createRadialGradient(
      CARD_W * 0.92, CARD_H * 0.95, 0,
      CARD_W * 0.92, CARD_H * 0.95, CARD_W * 0.6
    );
    glow2.addColorStop(0, accent + "14");
    glow2.addColorStop(1, accent + "00");
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    const padX = Math.round(CARD_W * 0.095);
    const isRtl = originalDir === "rtl";
    const alignSide = isRtl ? "right" : "left";
    const sideX = isRtl ? CARD_W - padX : padX;
    let y = Math.round(CARD_H * 0.155);

    // Reference / chapter tag (small, accent-colored, uppercase).
    ctx.textAlign = alignSide;
    ctx.direction = isRtl ? "rtl" : "ltr";
    ctx.fillStyle = accent;
    ctx.font = "600 27px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillText(String(chapterLabel || "").toUpperCase(), sideX, y);
    y += 58;

    // Hero: the verse in its own original-language script/font.
    ctx.fillStyle = fg;
    ctx.font = originalFont || "400 54px serif";
    ctx.direction = isRtl ? "rtl" : "ltr";
    const heroLineH = 76;
    const heroLines = wrapText(ctx, originalText, sideX, y, CARD_W - padX * 2, heroLineH, 6);
    y += heroLines * heroLineH + 46;

    // Divider.
    ctx.strokeStyle = accent + "66";
    ctx.lineWidth = 2;
    ctx.beginPath();
    const dividerX1 = isRtl ? CARD_W - padX : padX;
    const dividerX2 = isRtl ? dividerX1 - 60 : dividerX1 + 60;
    ctx.moveTo(dividerX1, y);
    ctx.lineTo(dividerX2, y);
    ctx.stroke();
    y += 50;

    // Translation (always LTR English, left-aligned regardless of the
    // original script's direction).
    ctx.direction = "ltr";
    ctx.textAlign = "left";
    ctx.fillStyle = fg;
    ctx.font = 'italic 400 39px Georgia, "Times New Roman", serif';
    const transLineH = 54;
    const transLines = wrapText(ctx, `“${translation}”`, padX, y, CARD_W - padX * 2, transLineH, 8);
    y += transLines * transLineH + 30;

    // Reference line under the translation.
    ctx.fillStyle = fgDim;
    ctx.font = "500 26px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillText(reference || "", padX, y);

    // Footer watermark: small mark + app name on the left, domain on the
    // right — discreet, not a hero element.
    const footerY = CARD_H - 72;
    ctx.strokeStyle = accent + "33";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, footerY - 34);
    ctx.lineTo(CARD_W - padX, footerY - 34);
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.font = "600 30px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillStyle = accent;
    const markText = mark || "";
    ctx.fillText(markText, padX, footerY);
    const markWidth = markText ? ctx.measureText(markText).width + 14 : 0;
    ctx.fillStyle = fgDim;
    ctx.font = "600 26px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillText(appName || "", padX + markWidth, footerY);

    ctx.textAlign = "right";
    ctx.fillStyle = fgDim;
    ctx.font = "400 22px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillText(domain || "", CARD_W - padX, footerY);

    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas.toBlob returned null"));
      }, "image/png");
    });
  }

  // Shares a rendered canvas as a real PNG file via the Web Share API
  // (native share sheet, file attached) when supported; falls back to a
  // plain <a download> if navigator.share/canShare with files isn't
  // available, or if the user's device rejects file sharing. Returns one
  // of "shared" | "downloaded" | "cancelled" so callers can toast
  // accordingly.
  async function shareCardImage(canvas, opts) {
    const { filename = "verse-card.png", shareText = "", shareTitle = "" } = opts || {};
    const blob = await canvasToBlob(canvas);
    const file = new File([blob], filename, { type: "image/png" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: shareText, title: shareTitle });
        return "shared";
      } catch (e) {
        if (e && e.name === "AbortError") return "cancelled";
        // Fall through to download on any other share failure.
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return "downloaded";
  }

  window.VerseCard = { renderVerseCard, shareCardImage, canvasToBlob, CARD_W, CARD_H };
})();
