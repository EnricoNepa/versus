/* =========================
   Versus Bracket - Firestore + Cloudinary (NO CARD)
   - Firestore: quizzes + subcollections items + stats
   - Cloudinary: image upload (unsigned preset)
   - Auth: anonymous
   - Optimistic UI on pick (no waiting server)
   - FIX Netlify: wait for Firebase init
   - Image suggestions: Wikimedia Commons
   - Bulk import: txt + zip/folder images
   - Faster play: image preloading + instant repaint
========================= */

const SIZES = [16, 32, 64, 128];
const $ = (id) => document.getElementById(id);

/* =========================
   Utils
========================= */
function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function debounce(fn, wait = 350) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function normalizeMatchKey(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase()
    .trim();
}

function isImageFilename(name) {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name || "");
}

async function fileToObjectUrl(file) {
  return URL.createObjectURL(file);
}

/* =========================
   Image preload cache
========================= */
const imgPreloadCache = new Map();

function preloadImage(url) {
  if (!url) return Promise.resolve();
  if (imgPreloadCache.has(url)) return imgPreloadCache.get(url);

  const p = new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.src = url;

    if (img.complete) {
      resolve(url);
      return;
    }

    img.onload = () => resolve(url);
    img.onerror = () => resolve(url);
  });

  imgPreloadCache.set(url, p);
  return p;
}

function preloadItems(items, limit = null) {
  const arr = limit == null ? items : items.slice(0, limit);
  return Promise.all(arr.map(it => preloadImage(it.imageUrl)));
}

function warmNextImages(run, pairsAhead = 4) {
  if (!run?.roundItems?.length) return;
  const start = run.pairIndex * 2;
  const end = start + (pairsAhead * 2);
  const upcoming = run.roundItems.slice(start, end);
  upcoming.forEach(it => preloadImage(it.imageUrl));
}

/* =========================
   Firebase handles
========================= */
async function fb() {
  const timeout = 10000;
  const start = Date.now();

  while (!window.__FB__) {
    if (Date.now() - start > timeout) {
      throw new Error("Firebase not initialized (timeout). Check index.html firebaseConfig.");
    }
    await sleep(50);
  }

  return window.__FB__;
}

/* =========================
   Firebase dynamic import
========================= */
let F = null;
async function fbImports() {
  if (F) return F;
  F = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
  return F;
}

/* =========================
   Cloudinary upload
========================= */
async function uploadToCloudinary(fileOrUrl) {
  const cloud = window.CLOUDINARY_CLOUD_NAME;
  const preset = window.CLOUDINARY_UPLOAD_PRESET;
  if (!cloud || !preset) throw new Error("Missing Cloudinary config in index.html");

  const url = `https://api.cloudinary.com/v1_1/${cloud}/image/upload`;
  const formData = new FormData();
  formData.append("file", fileOrUrl);
  formData.append("upload_preset", preset);

  const res = await fetch(url, { method: "POST", body: formData });
  if (!res.ok) throw new Error(`Cloudinary upload failed: ${res.status}`);
  const data = await res.json();
  if (!data.secure_url) throw new Error("Cloudinary response missing secure_url");
  return data.secure_url;
}

/* =========================
   Wikimedia Commons search
========================= */
async function searchCommonsImages(query, limit = 8) {
  const q = (query || "").trim();
  if (q.length < 3) return [];

  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("origin", "*");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", q);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(limit));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url");
  url.searchParams.set("iiurlwidth", "400");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Errore ricerca immagini");
  const data = await res.json();

  const pages = Object.values(data?.query?.pages || {});
  return pages
    .map(p => {
      const info = p.imageinfo?.[0];
      return info ? {
        title: p.title?.replace(/^File:/, "") || "",
        imageUrl: info.url || "",
        thumbUrl: info.thumburl || info.url || ""
      } : null;
    })
    .filter(Boolean);
}

/* =========================
   Firestore helpers
========================= */
async function listQuizzes() {
  const { db } = await fb();
  const FS = await fbImports();
  const q = FS.query(FS.collection(db, "quizzes"), FS.orderBy("createdAt", "desc"));
  const snap = await FS.getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getQuiz(quizId) {
  const { db } = await fb();
  const FS = await fbImports();
  const ref = FS.doc(db, "quizzes", quizId);
  const snap = await FS.getDoc(ref);
  return snap.exists() ? ({ id: snap.id, ...snap.data() }) : null;
}

async function listItems(quizId) {
  const { db } = await fb();
  const FS = await fbImports();
  const q = FS.query(FS.collection(db, "quizzes", quizId, "items"), FS.orderBy("createdAt", "asc"));
  const snap = await FS.getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function ensureStatsDoc(quizId, itemId) {
  const { db } = await fb();
  const FS = await fbImports();
  const ref = FS.doc(db, "quizzes", quizId, "stats", itemId);
  const snap = await FS.getDoc(ref);
  if (!snap.exists()) await FS.setDoc(ref, { wins: 0, matches: 0 });
}

async function incMatch(quizId, itemAId, itemBId, winnerId) {
  const { db } = await fb();
  const FS = await fbImports();

  await ensureStatsDoc(quizId, itemAId);
  await ensureStatsDoc(quizId, itemBId);
  await ensureStatsDoc(quizId, winnerId);

  const aRef = FS.doc(db, "quizzes", quizId, "stats", itemAId);
  const bRef = FS.doc(db, "quizzes", quizId, "stats", itemBId);
  const wRef = FS.doc(db, "quizzes", quizId, "stats", winnerId);

  await FS.runTransaction(db, async (tx) => {
    const a = await tx.get(aRef);
    const b = await tx.get(bRef);
    const w = await tx.get(wRef);

    tx.update(aRef, { matches: (a.data().matches || 0) + 1 });
    tx.update(bRef, { matches: (b.data().matches || 0) + 1 });
    tx.update(wRef, { wins: (w.data().wins || 0) + 1 });
  });
}

async function getStatsMap(quizId) {
  const { db } = await fb();
  const FS = await fbImports();
  const snap = await FS.getDocs(FS.collection(db, "quizzes", quizId, "stats"));
  const map = {};
  snap.forEach(d => { map[d.id] = d.data(); });
  return map;
}

/* =========================
   Background queue (retry)
========================= */
const bgQueue = [];
let bgWorking = false;

function enqueueBackground(fn) {
  bgQueue.push({ fn, tries: 0 });
  runBackgroundQueue();
}

async function runBackgroundQueue() {
  if (bgWorking) return;
  bgWorking = true;

  while (bgQueue.length) {
    const job = bgQueue[0];
    try {
      await job.fn();
      bgQueue.shift();
    } catch (e) {
      job.tries += 1;
      if (job.tries >= 5) {
        console.error("BG job dropped after retries:", e);
        bgQueue.shift();
      } else {
        await new Promise(r => setTimeout(r, 300 * job.tries));
      }
    }
  }

  bgWorking = false;
}

/* =========================
   App state
========================= */
let state = {
  route: "home",
  routeId: null,

  draft: {
    selectedSizes: new Set([16, 32]),
    coverSource: null,
    coverPreviewUrl: "",
    pendingItemSource: null,
    items: [],
  },

  run: null,
};

let homeCache = { quizzes: [] };

/* =========================
   Routing
========================= */
function go(route, id = null) {
  state.route = route;
  state.routeId = id;
  const hash = id ? `#${route}/${id}` : `#${route}`;
  if (location.hash !== hash) location.hash = hash;
  render().catch(console.error);
}

function parseHash() {
  const h = (location.hash || "#home").slice(1);
  const [route, id] = h.split("/");
  state.route = route || "home";
  state.routeId = id || null;
}

function showView(name) {
  const views = ["home","create","settings","play","results","rank"];
  for (const v of views) $(`view-${v}`).hidden = v !== name;
  $("homeSearchWrap").style.display = name === "home" ? "" : "none";
}

/* =========================
   Home
========================= */
async function renderHome() {
  const qTxt = ($("searchInput").value || "").trim().toLowerCase();

  if (homeCache.quizzes.length === 0) {
    homeCache.quizzes = await listQuizzes();
  }

  const quizzes = homeCache.quizzes.filter(x => !qTxt || (x.title || "").toLowerCase().includes(qTxt));

  $("homeCount").textContent = `${quizzes.length} quiz`;
  const grid = $("quizGrid");
  grid.innerHTML = "";
  $("homeEmpty").hidden = quizzes.length !== 0;

  for (const quiz of quizzes) {
    const card = document.createElement("div");
    card.className = "quizCard";
    card.innerHTML = `
      <img data-cover alt="">
      <div class="body">
        <div class="title">${escapeHtml(quiz.title || "")}</div>
        <div class="meta">${quiz.itemsCount || 0} elementi • sizes: ${(quiz.allowedSizes || []).join(", ")}</div>
      </div>
      <div class="overlay">
        <button class="btn primary" data-act="play">Play</button>
        <button class="btn" data-act="rank">Rank</button>
      </div>
    `;
    grid.appendChild(card);

    card.querySelector("[data-cover]").src = quiz.coverUrl || "";

        card.onclick = () => go("settings", quiz.id);

    card.querySelector('[data-act="play"]').onclick = (e) => {
      e.stopPropagation();
      go("settings", quiz.id);
    };

    card.querySelector('[data-act="rank"]').onclick = (e) => {
      e.stopPropagation();
      go("rank", quiz.id);
    };
  }
}

/* =========================
   Create
========================= */
function renderCreate() {
  const wrap = $("cqSizes");
  if (!wrap.dataset.ready) {
    wrap.dataset.ready = "1";
    wrap.innerHTML = "";
    for (const s of SIZES) {
      const chip = document.createElement("label");
      chip.className = "chip";
      chip.innerHTML = `<input type="checkbox" value="${s}"> ${s}`;
      const cb = chip.querySelector("input");
      cb.checked = state.draft.selectedSizes.has(s);
      cb.onchange = () => cb.checked ? state.draft.selectedSizes.add(s) : state.draft.selectedSizes.delete(s);
      wrap.appendChild(chip);
    }
  }

  const p = $("cqCoverPreview");
  if (state.draft.coverPreviewUrl) {
    p.style.display = "block";
    p.src = state.draft.coverPreviewUrl;
  } else {
    p.style.display = "none";
    p.src = "";
  }

  updateItemsUI();
}

function updateItemsUI() {
  $("itemsCount").textContent = `${state.draft.items.length} elementi`;
  const list = $("itemsList");
  list.innerHTML = "";

  for (const it of state.draft.items) {
    const row = document.createElement("div");
    row.className = "itemRow";
    row.innerHTML = `
      <img data-img alt="">
      <div class="grow">
        <div><b>${escapeHtml(it.name)}</b></div>
        <div class="small">${it.category ? escapeHtml(it.category) : "—"}</div>
      </div>
      <button class="btn danger">Rimuovi</button>
    `;
    row.querySelector("[data-img]").src = it.previewUrl || "";
    row.querySelector("button").onclick = () => {
      state.draft.items = state.draft.items.filter(x => x.id !== it.id);
      updateItemsUI();
    };
    list.appendChild(row);
  }
}

function onCoverPicked() {
  const f = $("cqCover").files?.[0];
  if (!f) return;
  state.draft.coverSource = f;
  state.draft.coverPreviewUrl = URL.createObjectURL(f);
  $("cqCoverPreview").style.display = "block";
  $("cqCoverPreview").src = state.draft.coverPreviewUrl;
}

function onItemImgPicked() {
  const f = $("itemImg").files?.[0];
  if (!f) return;
  state.draft.pendingItemSource = f;
  $("itemImgPreview").style.display = "block";
  $("itemImgPreview").src = URL.createObjectURL(f);
}

function addItem() {
  const name = ($("itemName").value || "").trim();
  const category = ($("itemCat").value || "").trim();
  const file = $("itemImg").files?.[0];
  const pickedSource = file || state.draft.pendingItemSource;

  if (!name) return alert("Inserisci il nome dell’elemento.");
  if (!pickedSource) return alert("Carica un’immagine o scegli un suggerimento.");

  const previewUrl = typeof pickedSource === "string"
    ? pickedSource
    : URL.createObjectURL(pickedSource);

  state.draft.items.push({
    id: uid("item"),
    name,
    category,
    source: pickedSource,
    previewUrl,
  });

  state.draft.pendingItemSource = null;
  $("itemName").value = "";
  $("itemCat").value = "";
  $("itemImg").value = "";
  $("itemImgPreview").style.display = "none";
  $("itemImgPreview").src = "";
  hideItemSuggestions();

  updateItemsUI();
}

async function saveQuiz() {
  const title = ($("cqTitle").value || "").trim();
  const description = ($("cqDesc").value || "").trim();
  const catsRaw = ($("cqCats").value || "").trim();
  const allowedSizes = Array.from(state.draft.selectedSizes).sort((a,b)=>a-b);

  if (!title) return alert("Inserisci un titolo.");
  if (!state.draft.coverSource) return alert("Carica una cover o scegli un suggerimento.");
  if (allowedSizes.length === 0) return alert("Seleziona almeno una size.");
  if (state.draft.items.length < 2) return alert("Aggiungi almeno 2 elementi.");

  const minSize = Math.min(...allowedSizes);
  if (state.draft.items.length < minSize) {
    return alert(`Hai ${state.draft.items.length} elementi, ma la size minima è ${minSize}. Aggiungi elementi o togli quella size.`);
  }

  const categories = catsRaw ? catsRaw.split(",").map(s=>s.trim()).filter(Boolean) : [];

  const { db } = await fb();
  const FS = await fbImports();

  const quizId = uid("quiz");
  const coverUrl = await uploadToCloudinary(state.draft.coverSource);

  await FS.setDoc(FS.doc(db, "quizzes", quizId), {
    title,
    description,
    coverUrl,
    allowedSizes,
    categories,
    itemsCount: state.draft.items.length,
    createdAt: FS.serverTimestamp(),
  });

  for (const it of state.draft.items) {
    const imageUrl = await uploadToCloudinary(it.source);

    await FS.setDoc(FS.doc(db, "quizzes", quizId, "items", it.id), {
      name: it.name,
      category: it.category || "",
      imageUrl,
      createdAt: FS.serverTimestamp(),
    });

    await ensureStatsDoc(quizId, it.id);
  }

  state.draft = {
    selectedSizes: new Set([16,32]),
    coverSource: null,
    coverPreviewUrl: "",
    pendingItemSource: null,
    items: []
  };

  $("cqTitle").value = "";
  $("cqDesc").value = "";
  $("cqCats").value = "";
  $("cqCover").value = "";
  $("cqCoverPreview").style.display = "none";
  $("cqCoverPreview").src = "";
  $("bulkTxtFile").value = "";
  $("bulkZipFile").value = "";
  $("bulkFolderInput").value = "";
  $("bulkStatus").textContent = "Nessun import eseguito";
  $("bulkPreviewWrap").hidden = true;
  $("cqSizes").dataset.ready = "";

  hideCoverSuggestions();
  hideItemSuggestions();

  homeCache.quizzes = [];
  go("home");
}

/* =========================
   Bulk import
========================= */
function parseTxtElements(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  return lines.map(line => {
    const parts = line.split(" - ");
    const title = (parts[0] || "").trim();
    const category = parts.slice(1).join(" - ").trim();
    return {
      raw: line,
      title,
      category
    };
  }).filter(x => x.title);
}

async function readTxtFile(file) {
  return await file.text();
}

async function extractImagesFromZip(zipFile) {
  if (!window.JSZip) throw new Error("JSZip non disponibile");
  const zip = await window.JSZip.loadAsync(zipFile);
  const out = [];

  const entries = Object.values(zip.files);
  for (const entry of entries) {
    if (entry.dir) continue;
    if (!isImageFilename(entry.name)) continue;

    const blob = await entry.async("blob");
    const file = new File([blob], entry.name.split("/").pop(), { type: blob.type || "image/*" });
    out.push(file);
  }
  return out;
}

function collectImagesFromFolder(fileList) {
  return Array.from(fileList || []).filter(f => isImageFilename(f.name));
}

async function processBulkImport() {
  const txtFile = $("bulkTxtFile").files?.[0];
  const zipFile = $("bulkZipFile").files?.[0];
  const folderFiles = $("bulkFolderInput").files;

  if (!txtFile) return alert("Carica prima il file .txt");
  if (!zipFile && (!folderFiles || folderFiles.length === 0)) {
    return alert("Carica un file .zip oppure una cartella immagini.");
  }

  $("bulkStatus").textContent = "Elaborazione in corso...";

  const txt = await readTxtFile(txtFile);
  const rows = parseTxtElements(txt);

  let imageFiles = [];
  if (zipFile) {
    imageFiles = await extractImagesFromZip(zipFile);
  } else {
    imageFiles = collectImagesFromFolder(folderFiles);
  }

  const imageMap = new Map();
  for (const file of imageFiles) {
    imageMap.set(normalizeMatchKey(file.name), file);
  }

  const imported = [];
  let matched = 0;

  for (const row of rows) {
    const key = normalizeMatchKey(row.title);
    const file = imageMap.get(key);

    if (!file) continue;

    matched += 1;
    imported.push({
      id: uid("item"),
      name: row.title,
      category: row.category,
      source: file,
      previewUrl: await fileToObjectUrl(file),
    });
  }

  if (imported.length === 0) {
    $("bulkStatus").textContent = "Nessun match trovato";
    $("bulkPreviewWrap").hidden = true;
    return;
  }

  const existingKeys = new Set(state.draft.items.map(x => normalizeMatchKey(x.name)));
  const deduped = imported.filter(x => !existingKeys.has(normalizeMatchKey(x.name)));

  state.draft.items.push(...deduped);
  updateItemsUI();

  $("bulkStatus").textContent = `Importati ${deduped.length} elementi (${matched} match trovati)`;
  $("bulkPreviewWrap").hidden = false;
  $("bulkPreviewCount").textContent = `${deduped.length} aggiunti`;

  const previewList = $("bulkPreviewList");
  previewList.innerHTML = "";
  deduped.forEach(it => {
    const row = document.createElement("div");
    row.className = "itemRow";
    row.innerHTML = `
      <img src="${it.previewUrl}" alt="">
      <div class="grow">
        <div><b>${escapeHtml(it.name)}</b></div>
        <div class="small">${it.category ? escapeHtml(it.category) : "—"}</div>
      </div>
    `;
    previewList.appendChild(row);
  });
}

/* =========================
   Suggestions UI
========================= */
function renderSuggestionTiles(container, items, onPick) {
  container.innerHTML = "";

  items.forEach(it => {
    const tile = document.createElement("div");
    tile.className = "suggestTile";
    tile.innerHTML = `
      <img src="${it.thumbUrl}" alt="">
      <div class="cap">${escapeHtml(it.title)}</div>
    `;
    tile.onclick = () => onPick(it);
    container.appendChild(tile);
  });
}

function showCoverSuggestions() {
  $("coverSuggestBox").hidden = false;
}
function hideCoverSuggestions() {
  $("coverSuggestBox").hidden = true;
  $("coverSuggestGrid").innerHTML = "";
}
function showItemSuggestions() {
  $("itemSuggestBox").hidden = false;
}
function hideItemSuggestions() {
  $("itemSuggestBox").hidden = true;
  $("itemSuggestGrid").innerHTML = "";
}

const debouncedCoverSuggest = debounce(async () => {
  const q = $("cqTitle").value.trim();
  if (q.length < 3) {
    hideCoverSuggestions();
    return;
  }
  showCoverSuggestions();
  const items = await searchCommonsImages(q, 8);
  renderSuggestionTiles($("coverSuggestGrid"), items, (it) => {
    state.draft.coverSource = it.imageUrl;
    state.draft.coverPreviewUrl = it.imageUrl;
    $("cqCover").value = "";
    $("cqCoverPreview").style.display = "block";
    $("cqCoverPreview").src = it.imageUrl;
  });
}, 400);

const debouncedItemSuggest = debounce(async () => {
  const q = $("itemName").value.trim();
  if (q.length < 3) {
    hideItemSuggestions();
    return;
  }
  showItemSuggestions();
  const items = await searchCommonsImages(q, 8);
  renderSuggestionTiles($("itemSuggestGrid"), items, (it) => {
    state.draft.pendingItemSource = it.imageUrl;
    $("itemImg").value = "";
    $("itemImgPreview").style.display = "block";
    $("itemImgPreview").src = it.imageUrl;
  });
}, 400);

async function manualOpenCoverSuggestions() {
  const q = $("cqTitle").value.trim();
  if (q.length < 3) return alert("Scrivi prima almeno 3 caratteri nel titolo.");
  showCoverSuggestions();
  const items = await searchCommonsImages(q, 8);
  renderSuggestionTiles($("coverSuggestGrid"), items, (it) => {
    state.draft.coverSource = it.imageUrl;
    state.draft.coverPreviewUrl = it.imageUrl;
    $("cqCover").value = "";
    $("cqCoverPreview").style.display = "block";
    $("cqCoverPreview").src = it.imageUrl;
  });
}

async function manualOpenItemSuggestions() {
  const q = $("itemName").value.trim();
  if (q.length < 3) return alert("Scrivi prima almeno 3 caratteri nel nome elemento.");
  showItemSuggestions();
  const items = await searchCommonsImages(q, 8);
  renderSuggestionTiles($("itemSuggestGrid"), items, (it) => {
    state.draft.pendingItemSource = it.imageUrl;
    $("itemImg").value = "";
    $("itemImgPreview").style.display = "block";
    $("itemImgPreview").src = it.imageUrl;
  });
}

/* =========================
   Tabs
========================= */
function switchCreateTab(mode) {
  const isManual = mode === "manual";
  $("tabManualBtn").classList.toggle("active", isManual);
  $("tabBulkBtn").classList.toggle("active", !isManual);
  $("tabManualPanel").hidden = !isManual;
  $("tabBulkPanel").hidden = isManual;
}

/* =========================
   Settings
========================= */
async function renderSettings(quizId) {
  const quiz = await getQuiz(quizId);
  if (!quiz) return go("home");

  $("psTitle").textContent = quiz.title || "";
  $("psDesc").textContent = quiz.description || "";
  $("psCover").src = quiz.coverUrl || "";

  const items = await listItems(quizId);

  const catSel = $("psCategory");
  const sizeSel = $("psSize");

  catSel.innerHTML = "";
  sizeSel.innerHTML = "";

  const hasCats = (quiz.categories && quiz.categories.length);

  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = hasCats ? "Tutte" : "—";
  catSel.appendChild(optAll);

  if (hasCats) {
    for (const c of quiz.categories) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      catSel.appendChild(o);
    }
  }

  function refreshSizes() {
    const selectedCategory = catSel.value || "";
    let pool = items.slice();

    if (selectedCategory) {
      const s = selectedCategory.trim().toLowerCase();
      pool = pool.filter(it => (it.category || "").trim().toLowerCase() === s);
    }

    const availableCount = pool.length;

    sizeSel.innerHTML = "";

    const allowed = (quiz.allowedSizes || []).filter(size => size <= availableCount);

    for (const s of allowed) {
      const o = document.createElement("option");
      o.value = String(s);
      o.textContent = String(s);
      sizeSel.appendChild(o);
    }

    if (allowed.length === 0) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "Nessuna size disponibile";
      sizeSel.appendChild(o);
      sizeSel.disabled = true;
    } else {
      sizeSel.disabled = false;
    }
  }

  refreshSizes();
  catSel.onchange = refreshSizes;

  $("startPlayBtn").onclick = () => {
    if (!sizeSel.value) {
      alert("Nessuna size disponibile per questa categoria.");
      return;
    }
    startRun(quiz, items).catch(console.error);
  };
}

async function startRun(quiz, items) {
  const selectedCategory = $("psCategory").value || "";
  const size = parseInt($("psSize").value, 10);
  const doShuffle = $("psShuffle").checked;

  let pool = items.slice();

  if (selectedCategory) {
    const s = selectedCategory.trim().toLowerCase();
    pool = pool.filter(it => (it.category || "").trim().toLowerCase() === s);
  }

  if (pool.length < size) return alert(`Elementi disponibili: ${pool.length}. Non bastano per ${size}.`);

  if (doShuffle) pool = shuffle(pool);
  pool = pool.slice(0, size);

  await preloadItems(pool, Math.min(pool.length, 12));

  state.run = {
    quizId: quiz.id,
    quizTitle: quiz.title,
    round: 1,
    roundItems: pool,
    allItems: pool.slice(),
    pairIndex: 0,
    winners: [],
    eliminations: [],
    picks: [],
    finalRanking: null,
    locked: false,
  };

  go("play");

  preloadItems(pool).catch(() => {});
}

/* =========================
   Play
========================= */
function setPlayButtonsEnabled(enabled) {
  $("choiceA").disabled = !enabled;
  $("choiceB").disabled = !enabled;
}

async function renderPlay() {
  const run = state.run;
  if (!run) return go("home");

  const totalPairs = Math.floor(run.roundItems.length / 2);
  const current = run.pairIndex + 1;
  $("playProgress").textContent = `Round ${run.round} • Match ${current}/${totalPairs}`;

  const a = run.roundItems[run.pairIndex * 2];
  const b = run.roundItems[run.pairIndex * 2 + 1];

  if (!a || !b) return advanceRound();

  warmNextImages(run, 4);

  $("nameA").textContent = a.name;
  $("nameB").textContent = b.name;
  $("imgA").src = a.imageUrl || "";
  $("imgB").src = b.imageUrl || "";

  run.locked = false;
  setPlayButtonsEnabled(true);

  $("choiceA").onclick = () => pickWinnerInstant(a, b, a);
  $("choiceB").onclick = () => pickWinnerInstant(a, b, b);
}

function pickWinnerInstant(a, b, winner) {
  const run = state.run;
  if (!run || run.locked) return;

  run.locked = true;
  setPlayButtonsEnabled(false);

  const loser = winner.id === a.id ? b : a;

  run.picks.push({ round: run.round, aId: a.id, bId: b.id, winnerId: winner.id });
  run.winners.push(winner);
  run.eliminations.push({ itemId: loser.id, eliminatedRound: run.round, eliminatedAt: run.eliminations.length });

  run.pairIndex += 1;

  warmNextImages(run, 4);

  requestAnimationFrame(() => {
    renderPlay().catch(console.error);
  });

  enqueueBackground(() => incMatch(run.quizId, a.id, b.id, winner.id));
}

function advanceRound() {
  const run = state.run;
  if (!run) return;

  if (run.roundItems.length === 1) return finishRun(run.roundItems[0]);

  run.roundItems = run.winners.slice();
  run.winners = [];
  run.pairIndex = 0;
  run.round += 1;

  if (run.roundItems.length === 1) return finishRun(run.roundItems[0]);

  warmNextImages(run, 4);
  renderPlay().catch(console.error);
}

function finishRun(winnerItem) {
  const run = state.run;
  if (!run) return;

  const maxRound = run.round + 1;
  run.eliminations.push({ itemId: winnerItem.id, eliminatedRound: maxRound, eliminatedAt: run.eliminations.length });

  const elimMap = new Map(run.eliminations.map(e => [e.itemId, e]));
  const all = run.allItems.slice();

  run.finalRanking = all.sort((x, y) => {
    const ex = elimMap.get(x.id);
    const ey = elimMap.get(y.id);
    const rx = ex ? ex.eliminatedRound : 0;
    const ry = ey ? ey.eliminatedRound : 0;
    if (ry !== rx) return ry - rx;
    const ax = ex ? ex.eliminatedAt : 0;
    const ay = ey ? ey.eliminatedAt : 0;
    return ax - ay;
  });

  go("results");
}

/* =========================
   Results
========================= */
function renderResults() {
  const run = state.run;
  if (!run?.finalRanking) return go("home");

  $("resTitle").textContent = run.quizTitle;
  const list = $("resList");
  list.innerHTML = "";

  run.finalRanking.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "rankRow";
    row.innerHTML = `
      <div class="pos">${idx + 1}</div>
      <img src="${it.imageUrl || ""}" alt="">
      <div class="grow">
        <div><b>${escapeHtml(it.name)}</b></div>
        <div class="stats">${it.category ? escapeHtml(it.category) : "—"}</div>
      </div>
    `;
    list.appendChild(row);
  });
}

/* =========================
   Rank
========================= */
async function renderRank(quizId) {
  const quiz = await getQuiz(quizId);
  if (!quiz) return go("home");

  $("rankTitle").textContent = `Rank: ${quiz.title || ""}`;

  const items = await listItems(quizId);
  const stats = await getStatsMap(quizId);

  const rows = items.map(it => {
    const s = stats[it.id] || { wins: 0, matches: 0 };
    const wr = s.matches > 0 ? (s.wins / s.matches) : 0;
    return { it, wins: s.wins, matches: s.matches, winrate: wr };
  });

  rows.sort((a, b) => {
    if (b.winrate !== a.winrate) return b.winrate - a.winrate;
    return b.matches - a.matches;
  });

  const list = $("rankList");
  list.innerHTML = "";

  rows.forEach((r, idx) => {
    const row = document.createElement("div");
    row.className = "rankRow";
    row.innerHTML = `
      <div class="pos">${idx + 1}</div>
      <img src="${r.it.imageUrl || ""}" alt="">
      <div class="grow">
        <div><b>${escapeHtml(r.it.name)}</b></div>
        <div class="stats">winrate ${(r.winrate * 100).toFixed(1)}% • ${r.wins}W / ${r.matches}M</div>
      </div>
    `;
    list.appendChild(row);
  });
}

/* =========================
   Main render
========================= */
async function render() {
  parseHash();

  switch (state.route) {
    case "home":
      showView("home");
      await renderHome();
      break;
    case "create":
      showView("create");
      renderCreate();
      break;
    case "settings":
      showView("settings");
      await renderSettings(state.routeId);
      break;
    case "play":
      showView("play");
      await renderPlay();
      break;
    case "results":
      showView("results");
      renderResults();
      break;
    case "rank":
      showView("rank");
      await renderRank(state.routeId);
      break;
    default:
      go("home");
  }
}

/* =========================
   UI wiring
========================= */
function wireUI() {
  $("goHome").addEventListener("click", () => go("home"));
  $("newQuizBtn").addEventListener("click", () => { homeCache.quizzes = []; go("create"); });

  $("searchInput").addEventListener("input", () => renderHome().catch(console.error));

  $("cqCover").addEventListener("change", onCoverPicked);
  $("itemImg").addEventListener("change", onItemImgPicked);

  $("cqTitle").addEventListener("input", () => debouncedCoverSuggest());
  $("cqTitle").addEventListener("focus", () => {
    if ($("cqTitle").value.trim().length >= 3) debouncedCoverSuggest();
  });

  $("itemName").addEventListener("input", () => debouncedItemSuggest());
  $("itemName").addEventListener("focus", () => {
    if ($("itemName").value.trim().length >= 3) debouncedItemSuggest();
  });

  $("openCoverSuggestBtn").addEventListener("click", () => manualOpenCoverSuggestions().catch(console.error));
  $("openItemSuggestBtn").addEventListener("click", () => manualOpenItemSuggestions().catch(console.error));
  $("closeCoverSuggestBtn").addEventListener("click", hideCoverSuggestions);
  $("closeItemSuggestBtn").addEventListener("click", hideItemSuggestions);

  $("addItemBtn").addEventListener("click", addItem);
  $("bulkProcessBtn").addEventListener("click", () => processBulkImport().catch(e => {
    console.error(e);
    $("bulkStatus").textContent = "Errore durante l'import";
    alert("Errore durante l'import automatico.");
  }));

  $("tabManualBtn").addEventListener("click", () => switchCreateTab("manual"));
  $("tabBulkBtn").addEventListener("click", () => switchCreateTab("bulk"));

  $("saveQuizBtn").addEventListener("click", () => saveQuiz().catch(e => {
    console.error(e);
    alert("Errore pubblicazione quiz.");
  }));

  $("cancelCreateBtn").addEventListener("click", () => {
    if (confirm("Annullare?")) {
      state.draft = {
        selectedSizes: new Set([16,32]),
        coverSource:null,
        coverPreviewUrl:"",
        pendingItemSource:null,
        items:[]
      };
      $("cqSizes").dataset.ready = "";
      hideCoverSuggestions();
      hideItemSuggestions();
      go("home");
    }
  });

  $("backFromSettings").addEventListener("click", () => go("home"));

  $("quitPlayBtn").addEventListener("click", () => {
    if (confirm("Uscire dal gioco?")) { state.run = null; go("home"); }
  });

  $("backHomeFromResults").addEventListener("click", () => { state.run = null; go("home"); });

  $("openRankFromResults").addEventListener("click", () => {
    const qid = state.run?.quizId;
    if (qid) go("rank", qid);
  });

  $("backFromRank").addEventListener("click", () => go("home"));

  window.addEventListener("hashchange", () => render().catch(console.error));
}

wireUI();
render().catch(console.error);