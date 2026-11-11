'use strict';

/* ================= State ================= */
const STORAGE_KEY = 'vokabeltrainer.pool.v1';
const $ = (id) => document.getElementById(id);

let vocabularyPool = [];   // {en, de, sentence}
let activeList = [];
let wrongAnswers = [];
let currentIndex = 0;
let mode = 'translate';    // 'translate' | 'gap'
let isRetry = false;
let isShowingResolution = false;
let mistakeCount = 0;
let isScanning = false;
let previewUrls = [];

/* ================= Helfer ================= */
const median = (arr) => {
    const a = [...arr].sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
};
function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
    }
    return dp[a.length][b.length];
}
/** Vergleichsform: ohne "to", ohne sb/sth, klein geschrieben */
const norm = (s) => s.toLowerCase()
    .replace(/^\s*\*?to\s+/, '')
    .replace(/\bsb\s*\/\s*sth\b|\bsth\s*\/\s*sb\b|\bsb\b|\bsth\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function setStatus(msg, type = 'busy') {
    const el = $('status-text');
    el.hidden = !msg;
    el.textContent = msg;
    el.style.color = { busy: '#b9770e', ok: '#1e8449', error: '#c0392b' }[type];
}
function showScreen(name) {
    ['scan', 'trainer', 'end'].forEach((n) => { $(`${n}-screen`).hidden = n !== name; });
}

/* ================= Persistenz ================= */
function savePool() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(vocabularyPool)); } catch (e) { /* z.B. privater Modus */ }
}
function loadSavedPool() {
    try {
        const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(data) ? data.filter((v) => v && v.en && v.de) : [];
    } catch (e) { return []; }
}

/* ================= Upload & OCR ================= */
function showPreviews(files) {
    previewUrls.forEach((u) => URL.revokeObjectURL(u));
    previewUrls = [];
    const box = $('preview-box');
    box.replaceChildren();
    files.forEach((f) => {
        const url = URL.createObjectURL(f);
        previewUrls.push(url);
        const img = new Image();
        img.src = url;
        img.alt = '';
        img.className = 'preview-img';
        box.append(img);
    });
}

/** Skaliert kleine Screenshots hoch, das verbessert die OCR deutlich */
async function prepareImage(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(4, Math.max(1, 2000 / bmp.width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas;
}

async function handleBatchUpload(files) {
    files = [...files].filter((f) => f.type.startsWith('image/'));
    if (!files.length || isScanning) return;
    if (typeof Tesseract === 'undefined') {
        setStatus('❌ Texterkennung konnte nicht geladen werden (Internet / Script-URL prüfen).', 'error');
        return;
    }

    isScanning = true;
    vocabularyPool = [];
    renderList();
    showPreviews(files);
    setStatus('⏳ Initialisiere Texterkennung…');

    let currentImg = 0;
    let failed = 0;
    let worker;
    try {
        worker = await Tesseract.createWorker('deu+eng', 1, {
            logger: (m) => {
                if (m.status === 'recognizing text') {
                    setStatus(`⏳ Bild ${currentImg}/${files.length}: ${Math.round(m.progress * 100)} %`);
                }
            }
        });

        for (let i = 0; i < files.length; i++) {
            currentImg = i + 1;
            setStatus(`⏳ Scanne Bild ${currentImg} von ${files.length}…`);
            try {
                const canvas = await prepareImage(files[i]);
                const { data } = await worker.recognize(canvas);
                addEntries(parseTable(data.words || []));
            } catch (err) {
                failed++;
                console.error(`Fehler bei Bild ${currentImg}:`, err);
            }
        }
    } catch (err) {
        console.error(err);
        setStatus('❌ Die Texterkennung konnte nicht gestartet werden.', 'error');
        isScanning = false;
        return;
    } finally {
        if (worker) await worker.terminate();
    }

    isScanning = false;
    if (vocabularyPool.length) {
        setStatus(`✅ ${vocabularyPool.length} Vokabeln erkannt${failed ? ` (${failed} Bild(er) fehlgeschlagen)` : ''}. Bitte kurz kontrollieren.`, 'ok');
    } else {
        setStatus('❌ Keine Vokabeln erkannt. Bitte Screenshot mit 3 gut lesbaren Spalten verwenden.', 'error');
    }
}

function addEntries(entries) {
    entries.forEach((e) => {
        if (!vocabularyPool.some((v) => norm(v.en) === norm(e.en))) vocabularyPool.push(e);
    });
    savePool();
    renderList();
}

/* ================= Tabellen-Parser (3 Spalten) ================= */
const PHON_RE = /[ˈˌːəɪʊɒʌæðθʃʒŋɑɔɜɛɡ|\[\]]|['’]\w|\w:/;

function groupLines(ws, medH) {
    const sorted = [...ws].sort((a, b) => a.yc - b.yc);
    const lines = [];
    for (const w of sorted) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.yc - w.yc) < medH * 0.6) {
            last.words.push(w);
            last.yc = last.words.reduce((s, x) => s + x.yc, 0) / last.words.length;
        } else {
            lines.push({ yc: w.yc, words: [w] });
        }
    }
    lines.forEach((l) => {
        l.words.sort((a, b) => a.x0 - b.x0);
        l.text = l.words.map((w) => w.t).join(' ');
    });
    return lines;
}

/** Findet die x-Startpositionen der 3 Spalten (k-means auf Segment-Anfängen) */
function findColumnStarts(words, pageW, medH) {
    const starts = [];
    groupLines(words, medH).forEach((line) => {
        starts.push(line.words[0].x0);
        for (let i = 1; i < line.words.length; i++) {
            if (line.words[i].x0 - line.words[i - 1].x1 > pageW * 0.015) starts.push(line.words[i].x0);
        }
    });
    let centers = [0.05, 0.27, 0.52].map((f) => f * pageW);
    let clusters;
    for (let it = 0; it < 15; it++) {
        clusters = [[], [], []];
        starts.forEach((x) => {
            let best = 0;
            centers.forEach((c, i) => { if (Math.abs(x - c) < Math.abs(x - centers[best])) best = i; });
            clusters[best].push(x);
        });
        centers = clusters.map((c, i) => (c.length ? median(c) : centers[i]));
    }
    return clusters.every((c) => c.length >= 2) ? centers : null;
}

function parseHeadword(raw) {
    let t = raw.replace(/^[\s\d*.]+/, '').replace(/\[[^\]]*\]?/g, ' ');
    t = t.split(',')[0].replace(/\s*\([^)]*\)?/g, ' ');
    const tokens = t.trim().split(/\s+/).filter(Boolean);
    const cut = tokens.findIndex((tok, i) => i > 0 && PHON_RE.test(tok));
    const kept = cut === -1 ? tokens : tokens.slice(0, cut);
    return kept.join(' ').replace(/[^\p{L}\s/.'-]/gu, '').trim();
}

function joinHyphenated(lines) {
    let out = '';
    for (const l of lines) {
        out = out.endsWith('-') ? out.slice(0, -1) + l : out + (out ? ' ' : '') + l;
    }
    return out.replace(/\s+/g, ' ').trim();
}

/** Beispielsatz = Zeilen bis zum ersten Hinweis (Fr./Lat./Pfeil) */
function extractSentence(lines) {
    const out = [];
    for (const l of lines) {
        if (/^(Fr|Lat)\.?\s/i.test(l) || /[→↔⟶⇒]|->|<->|—>|-»/.test(l)) break;
        out.push(l);
    }
    return joinHyphenated(out);
}

function parseTable(rawWords) {
    const words = rawWords
        .map((w) => ({ t: (w.text || '').trim(), x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1 }))
        .filter((w) => w.t && !/^[!|•·]+$/.test(w.t));
    if (words.length < 6) return [];
    words.forEach((w) => { w.yc = (w.y0 + w.y1) / 2; });

    const pageW = Math.max(...words.map((w) => w.x1));
    const medH = median(words.map((w) => w.y1 - w.y0));
    const starts = findColumnStarts(words, pageW, medH);
    if (!starts) return [];

    const margin = pageW * 0.012;
    const colOf = (w) => (w.x0 >= starts[2] - margin ? 2 : w.x0 >= starts[1] - margin ? 1 : 0);
    const cols = [[], [], []];
    words.forEach((w) => cols[colOf(w)].push(w));
    const [l1, l2, l3] = cols.map((c) => groupLines(c, medH));

    // Zeilenanfänge: Spalte-1-Zeile, die mit Spalte 2/3 oben bündig ist und Abstand zur Vorzeile hat
    const tol = medH * 0.7;
    const anchors = [];
    l1.forEach((l, i) => {
        const aligned = [...l2, ...l3].some((o) => Math.abs(o.yc - l.yc) <= tol);
        const gapOk = i === 0 || l.yc - l1[i - 1].yc > medH * 1.5;
        if (aligned && gapOk && parseHeadword(l.text).length >= 2) anchors.push(l);
    });

    const collect = (colLines, row) => {
        const out = [];
        let prev = row.a.yc;
        for (const l of colLines) {
            if (l.yc < row.top || l.yc >= row.end) continue;
            if (l.yc - prev > medH * 2.2) break;
            out.push(l.text.replace(/\s+/g, ' ').trim());
            prev = l.yc;
        }
        return out;
    };

    const entries = [];
    anchors.forEach((a, i) => {
        const row = { a, top: a.yc - tol, end: anchors[i + 1] ? anchors[i + 1].yc - tol : Infinity };
        const en = parseHeadword(collect(l1, row).join(' '));
        const de = joinHyphenated(collect(l2, row)).replace(/[|!•]/g, '').trim();
        const sentence = extractSentence(collect(l3, row)).replace(/\|/g, 'I');
        if (/^[A-Za-z]/.test(en) && en.split(' ').length <= 6 && de.length > 1 && sentence.length > 5) {
            entries.push({ en, de, sentence });
        }
    });
    return entries;
}

/* ================= Bearbeitbare Liste ================= */
function renderList() {
    const box = $('scanned-container');
    box.replaceChildren();

    const makeInput = (item, key, label, extraClass = '') => {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = item[key];
        input.setAttribute('aria-label', label);
        if (extraClass) input.className = extraClass;
        input.addEventListener('input', () => { item[key] = input.value; savePool(); });
        return input;
    };

    vocabularyPool.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'edit-row';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.textContent = '✕';
        del.setAttribute('aria-label', `${item.en} löschen`);
        del.addEventListener('click', () => {
            vocabularyPool.splice(idx, 1);
            savePool();
            renderList();
        });
        row.append(
            makeInput(item, 'en', 'Englisch'),
            makeInput(item, 'de', 'Deutsch'),
            del,
            makeInput(item, 'sentence', 'Beispielsatz', 'full')
        );
        box.append(row);
    });

    const n = vocabularyPool.length;
    $('scanned-title').textContent = `Erkannte Vokabeln (${n})`;
    $('scanned-box').hidden = n === 0;
    $('start-btn').hidden = n === 0;
}

/* ================= Prüflogik ================= */
/** Lückentext: ersetzt das (auch gebeugte) Lernwort im Satz */
function makeGap(item) {
    const base = norm(item.en).split(' ')[0];
    if (!base || base.length < 2) return null;
    let stem = base;
    if (stem.length > 4 && /[ey]$/.test(stem)) stem = stem.slice(0, -1);
    const re = new RegExp(`\\b${escapeRe(stem)}\\p{L}*`, 'iu');
    const m = item.sentence.match(re);
    if (!m) return null;
    const text = item.sentence.replace(new RegExp(re.source, 'giu'), '_____');
    return { text, match: m[0].toLowerCase() };
}

function judge(answer, item, extraTargets = []) {
    const a = norm(answer);
    if (!a) return null;
    const full = norm(item.en);
    const targets = [full, full.split(' ')[0], ...extraTargets];
    if (targets.includes(a)) return 'exact';
    if (targets.some((t) => t.length >= 5 && levenshtein(a, t) <= 1)) return 'typo';
    return null;
}

/* ================= Trainer ================= */
function initTrainer() {
    if (!vocabularyPool.length) return;
    activeList = shuffle([...vocabularyPool]);
    wrongAnswers = [];
    currentIndex = 0;
    mode = 'translate';
    isRetry = false;
    mistakeCount = 0;
    showScreen('trainer');
    showQuestion();
}

function showQuestion(notice = '') {
    isShowingResolution = false;
    const item = activeList[currentIndex];
    const input = $('user-input');
    const sentenceBox = $('sentence-box');

    input.value = '';
    input.readOnly = false;
    $('feedback-display').className = 'feedback';
    $('feedback-display').textContent = notice;
    $('action-btn').textContent = 'Antwort prüfen';
    $('stats-display').textContent = `Vokabel ${currentIndex + 1} von ${activeList.length}`;
    sentenceBox.hidden = true;

    if (mode === 'translate') {
        $('phase-title').textContent = isRetry ? 'Fehler-Wiederholung: Deutsch ➔ Englisch' : 'Runde 1: Deutsch ➔ Englisch';
        $('question-display').textContent = item.de;
        input.placeholder = 'Englische Übersetzung...';
    } else {
        $('phase-title').textContent = isRetry ? 'Fehler-Wiederholung: Lückentext' : 'Runde 2: Lückentext (Satz ➔ Wort)';
        $('question-display').textContent = 'Ergänze das fehlende Wort:';
        input.placeholder = 'Fehlendes Wort...';
        sentenceBox.textContent = `${makeGap(item).text}  (Hinweis: ${item.de})`;
        sentenceBox.hidden = false;
    }
    input.focus();
}

function checkAnswer() {
    if (isShowingResolution) return advance();

    const item = activeList[currentIndex];
    const gap = mode === 'gap' ? makeGap(item) : null;
    const result = judge($('user-input').value, item, gap ? [gap.match] : []);
    const feedback = $('feedback-display');

    if (result) {
        feedback.className = 'feedback correct';
        feedback.textContent = result === 'typo' ? `Richtig (kleiner Tippfehler) 🎉 Schreibweise: ${item.en}` : 'Richtig! 🎉';
    } else {
        mistakeCount++;
        feedback.className = 'feedback wrong';
        feedback.textContent = `Falsch ❌ Lösung: ${item.en}`;
        if (!wrongAnswers.includes(item)) wrongAnswers.push(item);
    }

    $('sentence-box').textContent = item.sentence;
    $('sentence-box').hidden = false;
    $('user-input').readOnly = true;
    $('action-btn').textContent = 'Weiter';
    isShowingResolution = true;
}

function advance() {
    currentIndex++;
    if (currentIndex < activeList.length) return showQuestion();

    // Ende einer Durchgangsrunde
    if (wrongAnswers.length) {
        activeList = shuffle([...wrongAnswers]);
        wrongAnswers = [];
        currentIndex = 0;
        isRetry = true;
        return showQuestion(`Noch ${activeList.length} Wackelkandidaten, nochmal!`);
    }
    if (mode === 'translate') return startGapRound();
    finish();
}

function startGapRound() {
    const gapItems = vocabularyPool.filter((v) => makeGap(v));
    if (!gapItems.length) return finish();
    mode = 'gap';
    isRetry = false;
    activeList = shuffle(gapItems);
    wrongAnswers = [];
    currentIndex = 0;
    showQuestion('Super! Runde 2: Ergänze das Wort im Satz.');
}

function finish() {
    $('end-text').textContent = `${vocabularyPool.length} Vokabeln durchgearbeitet, ${mistakeCount} Fehler insgesamt. Du bist bereit für den Test! 🎉`;
    showScreen('end');
    $('restart-btn').focus();
}

/* ================= Init ================= */
function init() {
    const fileInput = $('file-input');
    const zone = $('upload-zone');

    fileInput.addEventListener('change', () => {
        const files = [...fileInput.files];
        fileInput.value = '';          // gleiche Dateien erneut wählbar
        handleBatchUpload(files);
    });
    zone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('drop', (e) => { e.preventDefault(); handleBatchUpload(e.dataTransfer.files); });

    $('start-btn').addEventListener('click', initTrainer);
    $('action-btn').addEventListener('click', checkAnswer);
    $('user-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); checkAnswer(); }
    });
    $('restart-btn').addEventListener('click', initTrainer);
    $('back-btn').addEventListener('click', () => { showScreen('scan'); renderList(); });

    const saved = loadSavedPool();
    if (saved.length) {
        const loadBtn = $('load-btn');
        loadBtn.textContent = `💾 Gespeicherte Liste laden (${saved.length} Vokabeln)`;
        loadBtn.hidden = false;
        loadBtn.addEventListener('click', () => {
            vocabularyPool = saved;
            loadBtn.hidden = true;
            setStatus(`✅ ${saved.length} Vokabeln geladen.`, 'ok');
            renderList();
        });
    }
}

init();
