(() => {
  "use strict";

  const LS_ONBOARDED = "versling_onboarded_v1";
  const LS_POSITION = "versling_position_v1";
  const LS_LIKES = "versling_likes_v1";

  // localStorage.setItem/getItem can throw for real reasons that have
  // nothing to do with this app's logic: Safari private-mode quota, an
  // enterprise/MDM storage policy, a strict in-app browser (the exact kind
  // of WebView the app's own share feature sends people into), or storage
  // just being full. Every call site used to call localStorage directly, so
  // one throw inside the onboarding "Continue" handler left the overlay
  // permanently stuck open (confirmed live: #feed stays `inert` forever,
  // the whole app is unusable) and a throw inside the scroll observer
  // silently stopped position tracking + infinite-scroll growth for that
  // event. These wrappers make storage failures degrade gracefully instead.
  function lsGet(key) {
    try { return localStorage.getItem(key); }
    catch { return null; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch { return false; }
  }

  const topbarEl = document.getElementById("topbar");
  const feedEl = document.getElementById("feed");
  const pageTpl = document.getElementById("tpl-page");

  const detailEl = document.getElementById("detail");
  const surahsEl = document.getElementById("surahs");
  const savedEl = document.getElementById("saved");
  const savedListEl = document.getElementById("saved-list");
  const infoEl = document.getElementById("info");
  const toastEl = document.getElementById("toast");

  let surahMeta = [];        // from surahs.json
  let cumulative = [];       // cumulative verse counts, cumulative[i] = verses before surah i+1
  let totalVerses = 0;
  let surahCache = new Map(); // surahNumber -> array of verse objects
  let rendered = [];          // array of { gi, el, surah, ayah }
  let currentGi = 0;
  let loadingMore = false;
  let allSurahsLoaded = false;
  let allSurahsLoading = null;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.hidden = true; }, 1800);
  }

  function getLikes() {
    try { return new Set(JSON.parse(lsGet(LS_LIKES) || "[]")); }
    catch { return new Set(); }
  }
  function saveLikes(set) {
    lsSet(LS_LIKES, JSON.stringify([...set]));
  }

  // ---- global index <-> (surah, ayah) ----
  function giToSurahAyah(gi) {
    gi = ((gi % totalVerses) + totalVerses) % totalVerses; // wrap
    let lo = 0, hi = cumulative.length - 1;
    // cumulative[i] = total verses in surahs 1..i (1-indexed by position, surah i+1)
    for (let i = 0; i < cumulative.length; i++) {
      if (gi < cumulative[i]) {
        const surahNum = i + 1;
        const prev = i === 0 ? 0 : cumulative[i - 1];
        const ayah = gi - prev + 1;
        return { surah: surahNum, ayah };
      }
    }
    return { surah: 1, ayah: 1 };
  }

  function giFromSurahAyah(surah, ayah) {
    const prev = surah === 1 ? 0 : cumulative[surah - 2];
    return prev + (ayah - 1);
  }

  // ---- Deep links: ?v=surah:ayah ----
  function parseVerseRef(raw) {
    if (!raw) return null;
    const m = /^(\d{1,3}):(\d{1,3})$/.exec(raw.trim());
    if (!m) return null;
    const surah = parseInt(m[1], 10);
    const ayah = parseInt(m[2], 10);
    const info = surahInfo(surah);
    if (!info || ayah < 1 || ayah > info.ayahCount) return null;
    return { surah, ayah };
  }

  function verseUrl(surah, ayah) {
    return `${location.origin}${location.pathname}?v=${surah}:${ayah}`;
  }

  function updateUrlForGi(gi) {
    const { surah, ayah } = giToSurahAyah(gi);
    const url = `${location.pathname}?v=${surah}:${ayah}`;
    history.replaceState(null, "", url);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function truncate(s, n) {
    return s.length > n ? s.slice(0, n).trim() + "…" : s;
  }

  // Strip Quranic diacritics (tashkeel/tanween/Quranic annotation marks) and
  // normalize alef variants (آ أ إ ٱ -> ا) so Arabic search actually matches
  // real-world input. The stored Arabic text (Tanzil Uthmani script) carries
  // full diacritics on every letter, but a normal Arabic keyboard does not
  // produce those marks — without this, a plain-typed query like "الله"
  // never substring-matches the stored "اللَّهِ" and Arabic search is
  // effectively always empty for real users.
  function normalizeArabic(s) {
    return String(s)
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // tashkeel/tanween/Quranic marks
      .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627"); // alef variants -> plain alef
  }

  async function loadSurah(num) {
    if (surahCache.has(num)) return surahCache.get(num);
    const res = await fetch(`/data/surah-${num}.json`);
    if (!res.ok) throw new Error(`Failed to load surah ${num} (status ${res.status})`);
    const data = await res.json();
    surahCache.set(num, data);
    return data;
  }

  async function fetchJsonOrThrow(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url} (status ${res.status})`);
    return res.json();
  }

  function surahInfo(num) {
    return surahMeta[num - 1];
  }

  function fillPage(el, gi, verse) {
    const info = surahInfo(verse.surah);
    el.dataset.gi = gi;
    el.dataset.surah = verse.surah;
    el.dataset.ayah = verse.ayah;
    el.querySelector(".verse-ref").textContent = `${info.nameEnglish} ${verse.surah}:${verse.ayah}`;
    el.querySelector(".verse-arabic").textContent = verse.arabic;
    el.querySelector(".verse-translation").textContent = verse.translation;
    const likeBtn = el.querySelector(".act-like");
    const likes = getLikes();
    setLikeBtnState(likeBtn, likes.has(`${verse.surah}:${verse.ayah}`));
  }

  // Keeps the visual `.active` class and the real `aria-pressed` state in
  // sync. Before this, the heart/"Save verse" toggle only ever changed a CSS
  // class — a screen reader user got no indication a verse was saved (or
  // already saved) at all, since aria-pressed was never set on a real toggle
  // button. Confirmed live: pre-fix, aria-pressed stayed `null` before and
  // after clicking, even though the toast said "Saved" and the class toggled.
  function setLikeBtnState(btn, isSaved) {
    btn.classList.toggle("active", isSaved);
    btn.setAttribute("aria-pressed", String(isSaved));
  }

  async function buildPage(gi) {
    const { surah, ayah } = giToSurahAyah(gi);
    const verses = await loadSurah(surah);
    const verse = verses[ayah - 1];
    const frag = pageTpl.content.cloneNode(true);
    const el = frag.querySelector(".verse-page");
    fillPage(el, gi, verse);
    wirePageActions(el, verse);
    return el;
  }

  function wirePageActions(el, verse) {
    el.querySelector(".act-like").addEventListener("click", (e) => {
      e.stopPropagation();
      const key = `${verse.surah}:${verse.ayah}`;
      const likes = getLikes();
      if (likes.has(key)) { likes.delete(key); toast("Removed from saved"); } else { likes.add(key); toast("Saved"); }
      saveLikes(likes);
      setLikeBtnState(e.currentTarget, likes.has(key));
    });
    el.querySelector(".act-expand").addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail(verse);
    });
    el.querySelector(".act-share").addEventListener("click", async (e) => {
      e.stopPropagation();
      const info = surahInfo(verse.surah);
      const link = verseUrl(verse.surah, verse.ayah);
      const text = `${verse.arabic}\n\n"${verse.translation}"\n— Quran ${info.nameEnglish} ${verse.surah}:${verse.ayah}\n\n${link}`;
      if (navigator.share) {
        try { await navigator.share({ text, url: link }); } catch {}
      } else {
        try {
          await navigator.clipboard.writeText(text);
          toast("Link copied");
        } catch { toast("Could not copy"); }
      }
    });
    el.addEventListener("click", () => openDetail(verse));
  }

  function openDetail(verse) {
    const info = surahInfo(verse.surah);
    detailEl.querySelector(".sheet-ref").textContent = `Quran ${verse.surah}:${verse.ayah}`;
    detailEl.querySelector(".sheet-surah").textContent = `${info.nameEnglish} — ${info.meaning} (${info.revelationType})`;
    detailEl.querySelector(".sheet-context").textContent = info.context;
    detailEl.querySelector(".sheet-arabic").textContent = verse.arabic;
    detailEl.querySelector(".sheet-translit").textContent = verse.transliteration;
    detailEl.querySelector(".sheet-translation").textContent = `"${verse.translation}"`;
    detailEl.querySelector(".sheet-source").innerHTML =
      `Arabic: Tanzil Project, CC BY 3.0 — <a href="https://tanzil.net" target="_blank" rel="noopener">tanzil.net</a>. ` +
      `Translation: M. M. Pickthall (1930), public domain.`;
    const copyBtn = detailEl.querySelector(".sheet-copy-link");
    copyBtn.textContent = "Copy link";
    copyBtn.classList.remove("copied");
    copyBtn.onclick = async () => {
      const link = verseUrl(verse.surah, verse.ayah);
      try {
        await navigator.clipboard.writeText(link);
        copyBtn.textContent = "Copied";
        copyBtn.classList.add("copied");
        toast("Link copied");
      } catch { toast("Could not copy"); }
    };
    openSheet(detailEl);
  }

  // ---- Overlay/modal focus + keyboard containment ----
  // Every sheet and the onboarding screen are visually full-screen overlays
  // (CSS z-index + opaque backdrop), but before this fix nothing stopped a
  // keyboard user from Tab-ing straight through the topbar and feed buttons
  // sitting *underneath* an open overlay — those elements stayed in normal
  // DOM tab order and fully clickable via Enter/Space even while visually
  // hidden behind the sheet, and Escape did nothing, and opening a sheet
  // never moved focus into it (so a screen reader never even announced it
  // opened). `inert` removes the topbar+feed from the accessibility tree and
  // tab order for as long as any overlay is open, restoring real modal
  // behavior to match what already looked true visually.
  let openOverlays = 0;
  let lastFocusedEl = null;

  function focusableIn(container) {
    return [...container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )].filter((el) => !el.disabled && !el.hidden);
  }

  function pushOverlay(container) {
    openOverlays += 1;
    topbarEl.inert = true;
    feedEl.inert = true;
    lastFocusedEl = document.activeElement;
    const target = focusableIn(container)[0] || container;
    target.focus({ preventScroll: true });
  }

  function popOverlay() {
    openOverlays = Math.max(0, openOverlays - 1);
    if (openOverlays === 0) {
      topbarEl.inert = false;
      feedEl.inert = false;
    }
    if (lastFocusedEl && document.body.contains(lastFocusedEl)) {
      lastFocusedEl.focus({ preventScroll: true });
    }
    lastFocusedEl = null;
  }

  function topmostOpenOverlay() {
    return document.querySelector(".sheet:not([hidden])") ||
      (onboardEl && !onboardEl.hidden ? onboardEl : null);
  }

  document.addEventListener("keydown", (e) => {
    const overlay = topmostOpenOverlay();
    if (!overlay) return;
    if (e.key === "Escape") {
      if (overlay.classList.contains("sheet")) {
        e.preventDefault();
        closeSheet(overlay);
      }
      return; // onboarding has no Escape dismiss — it must be stepped through
    }
    if (e.key === "Tab") {
      const focusable = focusableIn(overlay);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  function openSheet(el) { el.hidden = false; pushOverlay(el); }
  function closeSheet(el) { el.hidden = true; popOverlay(); }
  document.querySelectorAll(".sheet .sheet-close").forEach(btn => {
    btn.addEventListener("click", () => closeSheet(btn.closest(".sheet")));
  });
  document.querySelectorAll(".sheet").forEach(sheet => {
    sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(sheet); });
  });

  // ---- Feed virtualization ----
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
        currentGi = parseInt(entry.target.dataset.gi, 10);
        lsSet(LS_POSITION, String(currentGi));
        updateUrlForGi(currentGi);
        maybeGrow();
        maybeGrowBack();
        maybePrune();
        maybePruneForward();
      }
    });
  }, { root: feedEl, threshold: [0.5] });

  async function appendPage(gi) {
    const el = await buildPage(gi);
    feedEl.appendChild(el);
    observer.observe(el);
    rendered.push({ gi, el });
  }

  async function prependPage(gi) {
    const el = await buildPage(gi);
    const prevScrollTop = feedEl.scrollTop;
    feedEl.insertBefore(el, feedEl.firstChild);
    observer.observe(el);
    rendered.unshift({ gi, el });
    // compensate so the content the user was looking at doesn't jump
    feedEl.scrollTop = prevScrollTop + el.getBoundingClientRect().height;
  }

  // Both of these must always reset loadingMore, even on failure (a dropped
  // request from a flaky mobile connection, a transient 5xx, etc.) — without
  // a finally block here, a single failed fetch inside appendPage/prependPage
  // leaves loadingMore stuck true forever, permanently stopping the feed from
  // growing in either direction for the rest of the session (only a full
  // page reload would recover). Resetting the flag lets the very next
  // intersection event retry the same page automatically.
  async function maybeGrow() {
    if (loadingMore) return;
    const last = rendered[rendered.length - 1];
    if (!last) return;
    if (last.gi - currentGi < 4) {
      loadingMore = true;
      try {
        const next = last.gi + 1;
        await appendPage(next);
      } catch (err) {
        console.error("Versling: failed to load the next verse", err);
        toast("Couldn't load more — check your connection");
      } finally {
        loadingMore = false;
      }
    }
  }

  async function maybeGrowBack() {
    if (loadingMore) return;
    const first = rendered[0];
    if (!first) return;
    if (currentGi - first.gi < 4) {
      loadingMore = true;
      try {
        const prev = first.gi - 1;
        await prependPage(prev);
      } catch (err) {
        console.error("Versling: failed to load the previous verse", err);
        toast("Couldn't load more — check your connection");
      } finally {
        loadingMore = false;
      }
    }
  }

  function maybePrune() {
    while (rendered.length > 14 && (currentGi - rendered[0].gi) > 8) {
      const first = rendered.shift();
      const h = first.el.getBoundingClientRect().height;
      first.el.remove();
      feedEl.scrollTop -= h;
    }
  }

  function maybePruneForward() {
    while (rendered.length > 14 && (rendered[rendered.length - 1].gi - currentGi) > 8) {
      const last = rendered.pop();
      last.el.remove();
    }
  }

  async function seedFeed(startGi) {
    feedEl.innerHTML = "";
    rendered = [];
    currentGi = startGi;
    for (let i = -2; i <= 4; i++) {
      await appendPage(startGi + i);
    }
    // scroll so startGi page is at top
    const target = rendered.find(r => r.gi === startGi);
    if (target) target.el.scrollIntoView({ block: "start" });
  }

  async function jumpToSurah(num) {
    await loadSurah(num);
    const prev = num === 1 ? 0 : cumulative[num - 2];
    await seedFeed(prev); // first ayah of that surah
    closeSheet(surahsEl);
  }

  async function jumpToVerse(surah, ayah) {
    await loadSurah(surah);
    await seedFeed(giFromSurahAyah(surah, ayah));
    closeSheet(surahsEl);
  }

  // ---- Surah browser + full-text search ----
  const surahListEl = document.getElementById("surah-list");
  const surahResultsEl = document.getElementById("surah-results");
  const surahSearchEl = document.getElementById("surah-search");
  const moreTextsEl = document.getElementById("more-texts-block");

  function filteredSurahMeta(q) {
    if (!q) return surahMeta;
    const qArabic = normalizeArabic(q);
    return surahMeta.filter((s) =>
      s.nameEnglish.toLowerCase().includes(q) ||
      s.meaning.toLowerCase().includes(q) ||
      normalizeArabic(s.nameArabic).includes(qArabic) ||
      s.context.toLowerCase().includes(q) ||
      String(s.number) === q
    );
  }

  function renderSurahList(q) {
    const list = filteredSurahMeta(q || "");
    if (!list.length) {
      surahListEl.innerHTML = `<p class="surah-empty">No surahs match.</p>`;
      return;
    }
    surahListEl.innerHTML = "";
    list.forEach(s => {
      const row = document.createElement("button");
      row.className = "surah-row";
      row.innerHTML = `
        <span class="surah-num">${s.number}</span>
        <span class="surah-names">
          <div class="surah-en">${escapeHtml(s.nameEnglish)} <span class="surah-meaning">· ${escapeHtml(s.meaning)}</span></div>
        </span>
        <span class="surah-ar">${escapeHtml(s.nameArabic)}</span>`;
      row.addEventListener("click", () => jumpToSurah(s.number));
      surahListEl.appendChild(row);
    });
  }

  async function ensureAllSurahsLoaded() {
    if (allSurahsLoaded) return;
    if (!allSurahsLoading) {
      allSurahsLoading = Promise.all(surahMeta.map(s => loadSurah(s.number))).then(() => {
        allSurahsLoaded = true;
      });
    }
    await allSurahsLoading;
  }

  function surahMatchHtml(s) {
    return `
      <button class="surah-result-item" data-surah="${s.number}" data-ayah="1">
        <div class="surah-result-tag">Surah ${s.number}</div>
        <p class="surah-result-text">${escapeHtml(s.nameEnglish)} &middot; ${escapeHtml(s.meaning)}</p>
      </button>
    `;
  }

  function verseMatchHtml(v) {
    const info = surahInfo(v.surah);
    return `
      <button class="surah-result-item" data-surah="${v.surah}" data-ayah="${v.ayah}">
        <div class="surah-result-tag">${escapeHtml(info.nameEnglish)} ${v.surah}:${v.ayah}</div>
        <p class="surah-result-text">${escapeHtml(truncate(v.translation, 140))}</p>
      </button>
    `;
  }

  let searchToken = 0;

  async function renderSearchResults(query) {
    const token = ++searchToken;
    const qLower = query.toLowerCase();
    const surahMatches = filteredSurahMeta(qLower);

    surahResultsEl.innerHTML =
      (surahMatches.length ? surahMatches.map(surahMatchHtml).join("") : "") +
      `<p class="surah-loading">Searching all 6,236 verses...</p>`;

    await ensureAllSurahsLoaded();
    if (token !== searchToken) return; // a newer search started while we were loading

    const verseMatches = [];
    const qArabic = normalizeArabic(query);
    outer:
    for (const s of surahMeta) {
      const verses = surahCache.get(s.number) || [];
      for (const v of verses) {
        if (
          v.translation.toLowerCase().includes(qLower) ||
          v.transliteration.toLowerCase().includes(qLower) ||
          normalizeArabic(v.arabic).includes(qArabic)
        ) {
          verseMatches.push(v);
          if (verseMatches.length >= 40) break outer;
        }
      }
    }

    if (!surahMatches.length && !verseMatches.length) {
      surahResultsEl.innerHTML = `<p class="surah-empty">No surahs or verses match "${escapeHtml(query)}".</p>`;
      return;
    }
    surahResultsEl.innerHTML =
      surahMatches.map(surahMatchHtml).join("") +
      verseMatches.map(verseMatchHtml).join("");
  }

  function handleSurahSearchInput() {
    const q = surahSearchEl.value.trim();
    if (!q) {
      surahResultsEl.hidden = true;
      surahListEl.hidden = false;
      if (moreTextsEl) moreTextsEl.hidden = false;
      return;
    }
    surahListEl.hidden = true;
    surahResultsEl.hidden = false;
    if (moreTextsEl) moreTextsEl.hidden = true;
    renderSearchResults(q);
  }

  surahSearchEl.addEventListener("input", handleSurahSearchInput);
  surahResultsEl.addEventListener("click", (e) => {
    const item = e.target.closest(".surah-result-item");
    if (!item) return;
    jumpToVerse(parseInt(item.dataset.surah, 10), parseInt(item.dataset.ayah, 10));
  });

  document.getElementById("btn-surahs").addEventListener("click", () => {
    surahSearchEl.value = "";
    surahResultsEl.hidden = true;
    surahListEl.hidden = false;
    if (moreTextsEl) moreTextsEl.hidden = false;
    renderSurahList("");
    openSheet(surahsEl);
  });
  document.getElementById("btn-info").addEventListener("click", () => openSheet(infoEl));

  // ---- Saved verses ----
  function savedItemHtml(p, v, info) {
    return `
      <div class="saved-item" data-surah="${p.surah}" data-ayah="${p.ayah}">
        <button class="saved-item-main" type="button">
          <div class="saved-item-tag">${escapeHtml(info.nameEnglish)} ${p.surah}:${p.ayah}</div>
          <p class="saved-item-text">${escapeHtml(truncate(v.translation, 140))}</p>
        </button>
        <button class="saved-item-remove" type="button" aria-label="Remove from saved" title="Remove from saved">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
        </button>
      </div>`;
  }

  async function renderSavedList() {
    const keys = [...getLikes()];
    if (!keys.length) {
      savedListEl.innerHTML = `<p class="saved-empty">No saved verses yet. Tap the heart on any verse to save it here.</p>`;
      return;
    }
    savedListEl.innerHTML = `<p class="surah-loading">Loading saved verses...</p>`;
    const parsed = keys
      .map((k) => {
        const [s, a] = k.split(":").map((n) => parseInt(n, 10));
        return { surah: s, ayah: a };
      })
      .filter((p) => surahInfo(p.surah) && Number.isFinite(p.ayah))
      .sort((x, y) => giFromSurahAyah(x.surah, x.ayah) - giFromSurahAyah(y.surah, y.ayah));
    const surahNums = [...new Set(parsed.map((p) => p.surah))];
    await Promise.all(surahNums.map((n) => loadSurah(n)));
    const html = parsed
      .map((p) => {
        const verses = surahCache.get(p.surah) || [];
        const v = verses[p.ayah - 1];
        const info = surahInfo(p.surah);
        return v && info ? savedItemHtml(p, v, info) : "";
      })
      .join("");
    savedListEl.innerHTML = html || `<p class="saved-empty">No saved verses yet. Tap the heart on any verse to save it here.</p>`;
  }

  savedListEl.addEventListener("click", (e) => {
    const item = e.target.closest(".saved-item");
    if (!item) return;
    const surah = parseInt(item.dataset.surah, 10);
    const ayah = parseInt(item.dataset.ayah, 10);
    if (e.target.closest(".saved-item-remove")) {
      const likes = getLikes();
      likes.delete(`${surah}:${ayah}`);
      saveLikes(likes);
      rendered.forEach((r) => {
        if (parseInt(r.el.dataset.surah, 10) === surah && parseInt(r.el.dataset.ayah, 10) === ayah) {
          setLikeBtnState(r.el.querySelector(".act-like"), false);
        }
      });
      renderSavedList();
      return;
    }
    closeSheet(savedEl);
    jumpToVerse(surah, ayah);
  });

  document.getElementById("btn-saved").addEventListener("click", () => {
    renderSavedList();
    openSheet(savedEl);
  });

  // Picks up likes written by another tab/window of this same app (e.g. a
  // verse saved in one open tab) so this tab's heart buttons and open Saved
  // sheet never show a stale snapshot. The read/write itself was already
  // confirmed race-free (fresh getLikes() on every write, no module-level
  // cache) — this only closes the separate UI-sync gap: without it, a
  // second open tab needed a manual reload to see the other tab's change.
  // Same pattern as Shloka's own "storage" listener (public/app.js).
  window.addEventListener("storage", (e) => {
    if (e.key !== LS_LIKES) return;
    const likes = getLikes();
    rendered.forEach((r) => {
      const key = `${r.el.dataset.surah}:${r.el.dataset.ayah}`;
      setLikeBtnState(r.el.querySelector(".act-like"), likes.has(key));
    });
    if (!savedEl.hidden) renderSavedList();
  });

  // ---- Onboarding ----
  const ONBOARD_SLIDES = [
    {
      icon: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/></svg>`,
      title: "The Quran, one verse at a time",
      body: "Swipe through short verses, full screen, with nothing else competing for your attention."
    },
    {
      icon: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
      title: "Tap to go deeper",
      body: "Tap any verse to see the Arabic text, a transliteration, the full translation, and brief context."
    },
    {
      icon: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20s-7-4.4-9.5-9.1C.8 7.6 2.3 4 5.8 4c2 0 3.3 1 4.2 2.4C11 5 12.2 4 14.2 4c3.5 0 5 3.6 3.3 6.9C19 15.6 12 20 12 20z"/></svg>`,
      title: "Save and share",
      body: "Keep verses that speak to you, and share any verse — Arabic, translation and reference together."
    },
    {
      icon: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v.01M11 11h1v5h1"/></svg>`,
      title: "Real text, real sources",
      body: "Arabic from the Tanzil Project, translation by M. M. Pickthall (1930, public domain) — both clearly credited throughout the app."
    },
  ];

  function renderOnboarding() {
    const slidesEl = document.getElementById("onboard-slides");
    const dotsEl = document.getElementById("onboard-dots");
    slidesEl.innerHTML = "";
    dotsEl.innerHTML = "";
    ONBOARD_SLIDES.forEach((s, i) => {
      const slide = document.createElement("div");
      slide.className = "onboard-slide";
      slide.innerHTML = `<div class="mark">${s.icon}</div><h2>${s.title}</h2><p>${s.body}</p>`;
      slidesEl.appendChild(slide);
      const dot = document.createElement("span");
      if (i === 0) dot.className = "on";
      dotsEl.appendChild(dot);
    });
    slidesEl.addEventListener("scroll", () => {
      const idx = Math.round(slidesEl.scrollLeft / slidesEl.clientWidth);
      [...dotsEl.children].forEach((d, i) => d.classList.toggle("on", i === idx));
      nextBtn.textContent = idx === ONBOARD_SLIDES.length - 1 ? "Start reading" : "Continue";
    });
  }

  const onboardEl = document.getElementById("onboarding");
  const nextBtn = document.getElementById("onboard-next");
  nextBtn.addEventListener("click", () => {
    const slidesEl = document.getElementById("onboard-slides");
    const idx = Math.round(slidesEl.scrollLeft / slidesEl.clientWidth);
    if (idx < ONBOARD_SLIDES.length - 1) {
      slidesEl.scrollTo({ left: slidesEl.clientWidth * (idx + 1), behavior: "smooth" });
    } else {
      lsSet(LS_ONBOARDED, "1");
      onboardEl.hidden = true;
      popOverlay();
    }
  });

  // ---- Boot ----
  // Every fetch in here (metadata + the initial seedFeed pages) can reject on
  // a dropped connection, a transient 5xx, or a bad JSON body — with no
  // try/catch, that leaves #feed permanently empty (just the static topbar on
  // a black screen) with zero indication anything went wrong and no way to
  // recover short of knowing to manually reload. Real users on a flaky
  // mobile connection would see a blank app forever. Catch it and offer a
  // real retry instead.
  function showBootError() {
    feedEl.innerHTML = `
      <div class="boot-error">
        <p>Couldn't load the Quran. Check your connection and try again.</p>
        <button id="boot-retry" type="button" class="btn-primary">Retry</button>
      </div>`;
    document.getElementById("boot-retry").addEventListener("click", () => {
      feedEl.innerHTML = "";
      boot();
    });
  }

  async function boot() {
    try {
      const [surahsRes, indexRes] = await Promise.all([
        fetchJsonOrThrow("/data/surahs.json"),
        fetchJsonOrThrow("/data/index.json"),
      ]);
      surahMeta = surahsRes;
      totalVerses = indexRes.totalVerses;
      let running = 0;
      cumulative = indexRes.surahs.map(s => { running += s.count; return running; });

      renderSurahList();
      renderOnboarding();

      const sharedRef = parseVerseRef(new URLSearchParams(location.search).get("v"));
      let startGi;
      if (sharedRef) {
        await loadSurah(sharedRef.surah);
        startGi = giFromSurahAyah(sharedRef.surah, sharedRef.ayah);
        toast(`Opened ${surahInfo(sharedRef.surah).nameEnglish} ${sharedRef.surah}:${sharedRef.ayah}`);
      } else {
        const savedPos = parseInt(lsGet(LS_POSITION) || "0", 10);
        startGi = Number.isFinite(savedPos) ? savedPos : 0;
      }
      await seedFeed(startGi);

      // a shared link should always show onboarding too, same as a fresh visit —
      // don't let a deep link silently skip the explainer for a brand-new user
      if (!lsGet(LS_ONBOARDED)) {
        onboardEl.hidden = false;
        pushOverlay(onboardEl);
      }
    } catch (err) {
      console.error("Versling: failed to start", err);
      showBootError();
    }
  }

  boot();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
})();
