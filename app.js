'use strict';

/* ================= Konstanten & State ================= */
const SESSION_KEY = 'vokabeltrainer.session';
const LANG_KEY = 'vokabeltrainer.lang';
const PREF_KEY = 'vokabeltrainer.practicePrefs';
const OLD_POOL_KEY = 'vokabeltrainer.pool.v1';
const GAP = '_____';
const $ = (id) => document.getElementById(id);

const LANGS = {
    fr: { name: 'Französisch', adj: 'französischen', ocr: 'fra+deu', dict: ['fr', 'de'] },
    en: { name: 'Englisch', adj: 'englischen', ocr: 'eng+deu', dict: ['en', 'de'] }
};
const DEFAULT_SETTINGS = { intervals: [0, 1, 3, 7, 14, 30], onWrong: 'reset', dailyGoal: 20, reminderTime: '18:00' };
const QMODES = ['translate', 'reverse', 'gap', 'mixed'];
// Texte auf der Karteikarte (hier einfach ändern)
const CARD_TEXT = { front: 'Tippen zum Umdrehen', back: 'Weiter mit Tippen oder Enter' };

let account = null;
let currentLang = 'fr';
let currentTab = 'learn';
let vocabularyPool = [];            // alle Sprachen
const confirmedWords = new Set();   // vom Nutzer bestätigte Wörter: nie automatisch ändern
let protectedWords = new Set();     // Wörter aus Stichwörtern: nie automatisch ändern
const deselected = new Set();       // abgewählte Bereiche beim Üben
const openSections = new Set();
let listQuery = '';
let onlyWarn = false;
let settings = { ...DEFAULT_SETTINGS, intervals: [...DEFAULT_SETTINGS.intervals] };
let stats = { days: {} };

let sessionKind = 'free';           // 'free' | 'daily' | 'trouble' | 'exam'
let qChoice = 'translate';          // gewählte Frageart: translate | reverse | gap | mixed
let practiceMode = false;           // Übungsmodus: vor der Abfrage Karteikarten für Vokabeln in Phase 1
let pendingKind = null;
let pendingExamId = null;
let sessionExam = null;
let exams = [];                     // Prüfungen: {id, name, date, ids, affect, progress}
let selectMode = false;             // Auswahlmodus in den Listen
const selectedIds = new Set();
let moveCtx = null;
let editingExamId = null;
let exCatState = [];
let cardList = [];
let cardIndex = 0;
let cardFlipped = false;
let afterCards = null;
let sessionPool = [];
let sessionDone = new Set();
let activeList = [];
let wrongAnswers = [];
let roundQueue = [];
let currentIndex = 0;
let mode = 'translate';             // Modus der aktuellen Runde (freies Üben)
let qMode = 'translate';            // Modus der aktuellen Frage
let isRetry = false;
let isShowingResolution = false;
let mistakeCount = 0;
let answeredCount = 0;
let promoted = 0;
let demoted = 0;
let isScanning = false;
let previewUrls = [];
let clearTimer = null;

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
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return dp[a.length][b.length];
}
const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** Vergleichsform: ohne "to", ohne sb/sth/qn/qc, klein geschrieben */
const norm = (s) => String(s).toLowerCase()
    .replace(/^\s*\*?to\s+/, '')
    .replace(/\b(?:sb|sth|qn|qc)\b(?:\s*\/\s*\b(?:sb|sth|qn|qc)\b)*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** Antwort-Vergleich: ohne Satzzeichen, einheitliche Apostrophe */
const normAns = (s) => norm(String(s).replace(/[’‘´`]/g, "'"))
    .replace(/[.,;:!?"“”„«»()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const letters = (s) => String(s).toLowerCase().match(/\p{L}+/gu) || [];
const FR_ART = /^(?:l'\s*|s'\s*|(?:le|la|les|un|une|des|se)\s+)+/;
const stripArticle = (s) => s.replace(FR_ART, '').trim();
const stemOf = (w) => (w.length >= 4 && /[ey]$/.test(w) ? w.slice(0, -1) : w);
/** Kernwort eines Stichworts (ohne Artikel/to/qn/qc, erste Alternative, erstes Wort) */
function coreWord(term) {
    const t = normAns(String(term).split('/')[0].replace(/\([^)]*\)?/g, ' '));
    return (stripArticle(t).split(' ')[0] || '').trim();
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const naturalCompare = (a, b) => a.localeCompare(b, 'de', { numeric: true });
const groupKey = (v) => (v.path.length ? v.path.join(' › ') : 'Ohne Bereich');
const sameVocab = (a, b) => a.lang === b.lang && norm(a.term) === norm(b.term);
const langPool = () => vocabularyPool.filter((v) => v.lang === currentLang);
const autofixOn = () => { const el = $('autofix'); return !el || el.checked; };
const normGapMarks = (s) => String(s).replace(/_{2,}/g, GAP);
const clampInt = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const setVal = (id, v) => { const el = $(id); if (el) el.value = v; };
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

function setStatus(msg, type = 'busy') {
    const el = $('status-text');
    el.hidden = !msg;
    el.textContent = msg;
    el.style.color = { busy: '#b9770e', ok: '#1e8449', error: '#c0392b' }[type];
}
function showScreen(name) {
    ['login', 'main', 'trainer', 'card', 'end'].forEach((n) => { $(`${n}-screen`).hidden = n !== name; });
}
function showTab(name) {
    currentTab = name;
    ['learn', 'lists', 'add', 'settings'].forEach((n) => {
        $(`view-${n}`).hidden = n !== name;
        $(`tab-${n}`).setAttribute('aria-selected', String(n === name));
    });
    if (name === 'learn') renderLearn();
    else if (name === 'lists') renderLists();
    else if (name === 'add') updatePathSuggest();
    else syncSettingsUI();
}
function refreshAll() {
    renderLearn();
    renderLists();
    updatePathSuggest();
    updateAddLabels();
}

function setLang(lang) {
    if (isScanning) { setStatus('Bitte warten, bis der Scan fertig ist.', 'busy'); return; }
    currentLang = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* egal */ }
    document.querySelectorAll('.lang-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    deselected.clear();
    openSections.clear();
    refreshAll();
}
function updateAddLabels() {
    const L = LANGS[currentLang];
    $('m-term-label').textContent = `${L.name} (z. B. ${currentLang === 'fr' ? 'le raté / la ratée' : 'to tower'})`;
    $('clear-btn').textContent = `Alle ${L.adj} Vokabeln löschen`;
    $('clear-btn').hidden = langPool().length === 0;
    $('export-btn').hidden = vocabularyPool.length === 0;
}

/* ================= Datum, Einstellungen, Statistik ================= */
const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Fälligkeit: 0 Tage = sofort, sonst Mitternacht (lokal) in n Tagen */
const dueTs = (days) => {
    const d = new Date();
    if (days <= 0) return d.getTime();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return d.getTime();
};
const todayStats = () => stats.days[dateKey()] || { n: 0, ok: 0, nw: 0 };
function touchToday() {
    const k = dateKey();
    if (!stats.days[k]) stats.days[k] = { n: 0, ok: 0, nw: 0 };
    return stats.days[k];
}
function streakDays() {
    const d = new Date();
    if (!(stats.days[dateKey(d)] && stats.days[dateKey(d)].n)) d.setDate(d.getDate() - 1);
    let n = 0;
    while (stats.days[dateKey(d)] && stats.days[dateKey(d)].n) { n++; d.setDate(d.getDate() - 1); }
    return n;
}
function relDay(ts) {
    const a = new Date(); a.setHours(0, 0, 0, 0);
    const b = new Date(ts); b.setHours(0, 0, 0, 0);
    const diff = Math.round((b - a) / 86400000);
    if (diff <= 0) return 'heute';
    if (diff === 1) return 'morgen';
    return `in ${diff} Tagen`;
}

function sanitizeSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const iv = Array.isArray(r.intervals) && r.intervals.length === 6
        ? r.intervals.map((n, i) => clampInt(n, 0, 365, DEFAULT_SETTINGS.intervals[i]))
        : [...DEFAULT_SETTINGS.intervals];
    return {
        intervals: iv,
        onWrong: r.onWrong === 'back' ? 'back' : 'reset',
        dailyGoal: clampInt(r.dailyGoal, 1, 500, DEFAULT_SETTINGS.dailyGoal),
        reminderTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.reminderTime)) ? String(r.reminderTime) : DEFAULT_SETTINGS.reminderTime
    };
}
function sanitizeStats(raw) {
    const days = {};
    const src = raw && raw.days && typeof raw.days === 'object' ? raw.days : {};
    Object.keys(src).forEach((k) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
        const d = src[k] || {};
        days[k] = { n: clampInt(d.n, 0, 100000, 0), ok: clampInt(d.ok, 0, 100000, 0), nw: clampInt(d.nw, 0, 100000, 0) };
    });
    const keys = Object.keys(days).sort();
    keys.slice(0, Math.max(0, keys.length - 400)).forEach((k) => delete days[k]);
    return { days };
}
function mergeStats(a, b) {
    const days = { ...a.days };
    Object.keys(b.days).forEach((k) => {
        const x = days[k], y = b.days[k];
        days[k] = x ? { n: Math.max(x.n, y.n), ok: Math.max(x.ok, y.ok), nw: Math.max(x.nw, y.nw) } : y;
    });
    return { days };
}

/* ================= Daten bereinigen ================= */
function sanitizePool(arr) {
    const strs = (x) => (Array.isArray(x) ? x.map(String).slice(0, 20) : []);
    return (Array.isArray(arr) ? arr : []).map((v) => {
        if (!v) return null;
        const term = String(v.term ?? v.en ?? '').trim();   // v.en: Format der alten Version
        const de = String(v.de ?? '').trim();
        if (!term || !de) return null;
        let path = Array.isArray(v.path) ? v.path.map((p) => String(p).trim()).filter(Boolean).slice(0, 3) : [];
        const mi = path.findIndex((p, i) => i > 0 && /^module\s/i.test(p));
        if (mi > 0) path = path.slice(mi);                    // Module sind eigene Hauptbereiche
        let lowc;
        if (v.lowc && typeof v.lowc === 'object') {
            const l = { term: strs(v.lowc.term), de: strs(v.lowc.de), sentence: strs(v.lowc.sentence) };
            if (l.term.length || l.de.length || l.sentence.length) lowc = l;
        }
        return {
            id: String(v.id || uid()),
            lang: v.lang === 'fr' ? 'fr' : 'en',
            term,
            de,
            sentence: normGapMarks(v.sentence || ''),
            gaps: Array.isArray(v.gaps) ? v.gaps.map((g) => ({
                n: Number.isFinite(g && g.n) ? g.n : null,
                a: String((g && g.a) || ''),
                auto: !!(g && g.auto),
                alts: Array.isArray(g && g.alts) ? g.alts.map(String).slice(0, 12) : []
            })) : [],
            path,
            fix: Array.isArray(v.fix) && v.fix.length ? v.fix : undefined,
            warn: Array.isArray(v.warn) && v.warn.length ? v.warn.map(String) : undefined,
            lowc,
            phase: clampInt(v.phase, 1, 6, 1),
            due: Number(v.due) || 0,
            ok: Number(v.ok) || 0,
            bad: Number(v.bad) || 0,
            streak: clampInt(v.streak, 0, 1000, 0)
        };
    }).filter(Boolean);
}
function rebuildProtected() {
    protectedWords = new Set();
    vocabularyPool.forEach((v) => letters(v.term).forEach((w) => protectedWords.add(w)));
}
const isProtected = (w) => protectedWords.has(w) || confirmedWords.has(w);
const addConfirmed = (text) => letters(text).forEach((w) => confirmedWords.add(w));

/* ================= Prüfungen ================= */
function sanitizeExams(arr) {
    return (Array.isArray(arr) ? arr : []).map((x) => {
        if (!x || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.date))) return null;
        const progress = {};
        if (x.progress && typeof x.progress === 'object') {
            Object.keys(x.progress).forEach((k) => {
                const p = x.progress[k] || {};
                progress[k] = { ok: clampInt(p.ok, 0, 9999, 0), bad: clampInt(p.bad, 0, 9999, 0), streak: clampInt(p.streak, 0, 99, 0), due: Number(p.due) || 0 };
            });
        }
        return {
            id: String(x.id || uid()),
            name: String(x.name || 'Prüfung').slice(0, 60),
            date: String(x.date),
            ids: Array.isArray(x.ids) ? [...new Set(x.ids.map(String))] : [],
            affect: !!x.affect,
            progress
        };
    }).filter(Boolean);
}
/** Tage bis zur Prüfung (0 = heute, negativ = vorbei) */
function examDays(exam) {
    const a = new Date();
    a.setHours(0, 0, 0, 0);
    const [y, m, d] = exam.date.split('-').map(Number);
    return Math.round((new Date(y, m - 1, d) - a) / 86400000);
}
const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
function examItems(exam) {
    const set = new Set(exam.ids);
    return vocabularyPool.filter((v) => set.has(v.id));
}
function examDueItems(exam) {
    const now = Date.now();
    return examItems(exam).filter((v) => { const p = exam.progress[v.id]; return !p || p.due <= now; });
}
/** Eigene Wiederholungsplanung der Prüfung: Schwache Vokabeln kommen täglich, sichere seltener, alle spätestens am Tag vor der Prüfung */
function examSchedule(exam, item, correct) {
    const p = exam.progress[item.id] || (exam.progress[item.id] = { ok: 0, bad: 0, streak: 0, due: 0 });
    if (correct) { p.ok++; p.streak++; } else { p.bad++; p.streak = 0; }
    const days = examDays(exam);
    const ladder = [0, 1, 2, 3, 5, 7];
    let interval = ladder[Math.min(p.streak, ladder.length - 1)];
    if (days <= 3) interval = Math.min(interval, 1);
    if (days <= 0) interval = 0;
    let due = dueTs(interval);
    if (days > 1) { const last = dueTs(days - 1); if (due > last) due = last; }
    p.due = correct ? due : Date.now();
}

/* ================= Konten & Speicherung (Supabase) ================= */
const SUPABASE_URL = 'https://tjdgptcdlaaonuiogbzn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_3qPEGh16ss9PzCWpJjuAeQ_zxwTPupX';
const AUTH_DOMAIN = 'vokabeltrainer.app';   // nur für die interne Pseudo-E-Mail, es wird nie eine Mail versendet
// Öffentlicher VAPID-Schlüssel für Erinnerungen (aus Schritt 1 der Push-Einrichtung). Solange hier der Platzhalter steht, ist Push aus.
const VAPID_PUBLIC_KEY = 'HIER_DEN_OEFFENTLICHEN_SCHLUESSEL_EINTRAGEN';
const sb = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

let syncMeta = { base: null, dirty: false };
let changeSeq = 0;
let saveTimer = null;
let saving = false;
let syncBlocked = false;

const SYNC_TEXT = {
    saved: 'Gespeichert',
    saving: 'Speichert...',
    dirty: 'Nicht gespeichert',
    offline: 'Offline, wird später gespeichert',
    conflict: 'Konflikt',
    none: ''
};
function setSync(state) {
    const el = $('sync-state');
    if (el) el.textContent = SYNC_TEXT[state] ?? '';
}

const dataKey = () => `vokabeltrainer.data.v2.${account.guest ? 'guest' : account.id}`;
const payload = () => ({ v: 4, pool: vocabularyPool, confirmed: [...confirmedWords], settings, stats, exams });

function applyPayloadExtras(data) {
    settings = sanitizeSettings(data && data.settings);
    stats = sanitizeStats(data && data.stats);
    exams = sanitizeExams(data && data.exams);
}

function writeCache() {
    try {
        localStorage.setItem(dataKey(), JSON.stringify({ ...payload(), base: syncMeta.base, dirty: syncMeta.dirty }));
    } catch (e) {
        setStatus('Lokales Speichern nicht möglich (Speicher voll oder privater Modus).', 'error');
    }
}
function loadLocal() {
    vocabularyPool = [];
    confirmedWords.clear();
    applyPayloadExtras(null);
    syncMeta = { base: null, dirty: false };
    try {
        let data = JSON.parse(localStorage.getItem(dataKey()) || 'null');
        if (!data && account.guest) {   // Übernahme aus älteren Versionen (nur Gast)
            data = JSON.parse(localStorage.getItem('vokabeltrainer.data.v1.guest') || 'null');
            if (!data) data = { pool: JSON.parse(localStorage.getItem(OLD_POOL_KEY) || '[]') };
        }
        if (data) {
            vocabularyPool = sanitizePool(data.pool);
            (data.confirmed || []).forEach((w) => confirmedWords.add(String(w)));
            applyPayloadExtras(data);
            if (!account.guest) syncMeta = { base: data.base || null, dirty: !!data.dirty };
        }
    } catch (e) { /* leer starten */ }
    rebuildProtected();
}

function savePool() {
    if (!account) return;
    changeSeq++;
    if (!account.guest) syncMeta.dirty = true;
    writeCache();
    if (account.guest) return;
    setSync('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushToCloud, 1500);
}

function applyRemote(row) {
    const d = row.data || {};
    vocabularyPool = sanitizePool(d.pool);
    confirmedWords.clear();
    (d.confirmed || []).forEach((w) => confirmedWords.add(String(w)));
    applyPayloadExtras(d);
    syncMeta = { base: row.updated_at, dirty: false };
    rebuildProtected();
    writeCache();
    syncSettingsUI();
    refreshAll();
    setSync('saved');
}

async function pushToCloud() {
    if (!sb || !account || account.guest || saving || syncBlocked) return;
    clearTimeout(saveTimer);
    saving = true;
    setSync('saving');
    const seq = changeSeq;
    const data = payload();
    const now = new Date().toISOString();
    let outcome = 'ok';
    try {
        let res;
        if (syncMeta.base) {
            res = await sb.from('vocab_data').update({ data, updated_at: now })
                .eq('user_id', account.id).eq('updated_at', syncMeta.base).select('updated_at');
        } else {
            res = await sb.from('vocab_data').insert({ user_id: account.id, data, updated_at: now }).select('updated_at');
        }
        if (res.error) {
            if (res.error.code === '23505') outcome = 'conflict';
            else throw res.error;
        } else if (!res.data || !res.data.length) {
            outcome = 'conflict';
        } else {
            syncMeta.base = res.data[0].updated_at;
            syncMeta.dirty = changeSeq !== seq;
            writeCache();
            setSync(syncMeta.dirty ? 'dirty' : 'saved');
        }
    } catch (err) {
        console.warn('Cloud-Speichern fehlgeschlagen', err);
        outcome = 'error';
        setSync('offline');
    } finally {
        saving = false;
    }
    if (outcome === 'conflict') return resolveConflict();
    if (syncMeta.dirty) saveTimer = setTimeout(pushToCloud, outcome === 'error' ? 15000 : 800);
}

function askConflict(remoteCount) {
    return new Promise((resolve) => {
        const box = $('conflict-box');
        $('conflict-text').textContent = `Cloud: ${remoteCount} Vokabeln · Dieses Gerät: ${vocabularyPool.length} Vokabeln.`;
        box.hidden = false;
        box.focus();
        const done = (choice) => { box.hidden = true; resolve(choice); };
        $('cf-merge').onclick = () => done('merge');
        $('cf-cloud').onclick = () => done('cloud');
        $('cf-local').onclick = () => done('local');
    });
}

async function resolveConflict() {
    syncBlocked = true;
    setSync('conflict');
    let proceed = false;
    try {
        const { data: row, error } = await sb.from('vocab_data').select('data, updated_at').eq('user_id', account.id).maybeSingle();
        if (error) throw error;
        if (!row) {
            syncMeta.base = null;
            proceed = true;
        } else {
            const d = row.data || {};
            const remotePool = sanitizePool(d.pool);
            const choice = await askConflict(remotePool.length);
            if (choice === 'cloud') {
                applyRemote(row);
            } else {
                if (choice === 'merge') {
                    remotePool.forEach((v) => {
                        if (!vocabularyPool.some((x) => sameVocab(x, v))) vocabularyPool.push(v);
                    });
                    (d.confirmed || []).forEach((w) => confirmedWords.add(String(w)));
                    stats = mergeStats(stats, sanitizeStats(d.stats));
                    sanitizeExams(d.exams).forEach((x) => { if (!exams.some((e) => e.id === x.id)) exams.push(x); });
                }
                syncMeta.base = row.updated_at;
                syncMeta.dirty = true;
                proceed = true;
            }
        }
    } catch (err) {
        console.warn('Konfliktprüfung fehlgeschlagen', err);
        setSync('offline');
        saveTimer = setTimeout(pushToCloud, 15000);
    } finally {
        syncBlocked = false;
    }
    if (proceed) {
        rebuildProtected();
        changeSeq++;
        writeCache();
        refreshAll();
        await pushToCloud();
    }
}

async function syncOnLogin() {
    if (!sb || !account || account.guest || saving || syncBlocked) return;
    setSync('saving');
    try {
        const { data: row, error } = await sb.from('vocab_data').select('data, updated_at').eq('user_id', account.id).maybeSingle();
        if (error) throw error;
        if (!row) {
            syncMeta.base = null;
            if (vocabularyPool.length) { syncMeta.dirty = true; return pushToCloud(); }
            return setSync('saved');
        }
        if (row.updated_at === syncMeta.base) {
            if (syncMeta.dirty) return pushToCloud();
            return setSync('saved');
        }
        if (!syncMeta.dirty) return applyRemote(row);
        return resolveConflict();
    } catch (err) {
        console.warn('Cloud-Abgleich fehlgeschlagen', err);
        setSync('offline');
        if (syncMeta.dirty) saveTimer = setTimeout(pushToCloud, 15000);
    }
}

async function enterAccount(acc) {
    account = acc;
    if (acc.guest) sessionStorage.setItem(SESSION_KEY, 'guest');
    else sessionStorage.removeItem(SESSION_KEY);
    loadLocal();
    $('account-name').textContent = acc.guest ? 'Gast (nur dieses Gerät)' : acc.name;
    $('login-pass').value = '';
    setStatus('');
    setSync(acc.guest ? 'none' : (syncMeta.dirty ? 'dirty' : 'saved'));
    syncSettingsUI();

    let lang = null;
    try { const s = localStorage.getItem(LANG_KEY); if (s === 'fr' || s === 'en') lang = s; } catch (e) { /* egal */ }
    if (!lang) {
        const fr = vocabularyPool.filter((v) => v.lang === 'fr').length;
        const en = vocabularyPool.filter((v) => v.lang === 'en').length;
        lang = en > fr ? 'en' : 'fr';
    }
    showScreen('main');
    setLang(lang);
    showTab('learn');
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if (!acc.guest) {
        await syncOnLogin();
        ensurePushRow();
    }
}

async function logout() {
    clearTimeout(saveTimer);
    if (account && !account.guest) {
        if (syncMeta.dirty) await pushToCloud();
        if (syncMeta.dirty && !confirm('Es gibt Änderungen, die noch nicht in der Cloud gespeichert sind. Trotzdem abmelden? Diese Änderungen gehen verloren.')) return;
        await removePushRow();   // auf gemeinsam genutzten Geräten keine fremden Erinnerungen
        try { localStorage.removeItem(dataKey()); } catch (e) { /* egal */ }
        if (sb) { try { await sb.auth.signOut(); } catch (e) { /* egal */ } }
    }
    sessionStorage.removeItem(SESSION_KEY);
    account = null;
    vocabularyPool = [];
    confirmedWords.clear();
    exams = [];
    syncMeta = { base: null, dirty: false };
    $('conflict-box').hidden = true;
    showScreen('login');
}

function authErrorText(err) {
    const code = err.code || '';
    const m = (err.message || '').toLowerCase();
    if (code === 'user_already_exists' || m.includes('already registered')) return 'Diesen Benutzernamen gibt es schon.';
    if (code === 'invalid_credentials' || m.includes('invalid login')) return 'Benutzername oder Passwort stimmt nicht.';
    if (code === 'weak_password') return 'Das Passwort ist zu schwach (mindestens 6 Zeichen).';
    if (code === 'email_address_invalid') return 'Der Benutzername wurde vom Server abgelehnt. (Hinweis für den Betreiber: AUTH_DOMAIN in app.js ändern.)';
    if (code.startsWith('over_') || err.status === 429) return 'Zu viele Versuche. Bitte kurz warten.';
    return `Fehler: ${err.message || 'unbekannt'}`;
}

async function authSubmit(kind) {
    const msg = (t) => { const el = $('login-msg'); el.textContent = t; el.hidden = !t; };
    if (!sb) return msg('Der Konto-Dienst konnte nicht geladen werden (Internet prüfen und Seite neu laden).');
    const name = $('login-user').value.trim().toLowerCase();
    const pw = $('login-pass').value;
    if (!/^[a-z0-9_.-]{3,24}$/.test(name)) return msg('Benutzername: 3 bis 24 Zeichen (Buchstaben, Zahlen, _ . -).');
    if (pw.length < 6) return msg('Das Passwort braucht mindestens 6 Zeichen.');

    const buttons = $('login-form').querySelectorAll('button');
    const setBusy = (b) => buttons.forEach((x) => { x.disabled = b; });
    setBusy(true);
    msg('');

    // 1) Anmeldung beim Konto-Dienst
    let res;
    try {
        const email = `${name}@${AUTH_DOMAIN}`;
        res = kind === 'register'
            ? await sb.auth.signUp({ email, password: pw })
            : await sb.auth.signInWithPassword({ email, password: pw });
    } catch (e) {
        setBusy(false);
        return msg('Verbindung zum Konto-Dienst fehlgeschlagen. Bitte Internetverbindung prüfen.');
    }

    // 2) Ergebnis auswerten und App starten
    try {
        if (res.error) return msg(authErrorText(res.error));
        const user = res.data.user;
        if (kind === 'register' && user && user.identities && !user.identities.length) return msg('Diesen Benutzernamen gibt es schon.');
        if (!res.data.session) return msg('Konto angelegt, aber keine Anmeldung möglich: In Supabase muss „Confirm email“ ausgeschaltet sein.');
        await enterAccount({ id: user.id, name, guest: false });
    } catch (e) {
        console.error(e);
        msg(`Die Anmeldung war erfolgreich, aber die App konnte nicht starten: ${e.message || e}`);
    } finally {
        setBusy(false);
    }
}

/* Sicherung als Datei */
function exportBackup() {
    const blob = new Blob([JSON.stringify({ app: 'vokabeltrainer', ...payload() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vokabeltrainer-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importBackup(file) {
    try {
        const data = JSON.parse(await file.text());
        let added = 0;
        sanitizePool(data.pool).forEach((v) => {
            if (!vocabularyPool.some((x) => sameVocab(x, v))) { vocabularyPool.push(v); added++; }
        });
        (data.confirmed || []).forEach((w) => confirmedWords.add(String(w)));
        if (data.settings) settings = sanitizeSettings(data.settings);
        if (data.stats) stats = mergeStats(stats, sanitizeStats(data.stats));
        sanitizeExams(data.exams).forEach((x) => { if (!exams.some((e) => e.id === x.id)) exams.push(x); });
        rebuildProtected();
        savePool();
        syncSettingsUI();
        refreshAll();
        setStatus(`Sicherung geladen: ${added} neue Vokabeln.`, 'ok');
    } catch (e) {
        setStatus('Die Datei konnte nicht gelesen werden.', 'error');
    }
}

/* ================= Wörterbuch ================= */
const DICT_SOURCES = {
    en: { local: 'woerter-en.json', pkg: 'an-array-of-english-words@2.0.0' },
    de: { local: 'woerter-de.json', pkg: 'an-array-of-german-words@1.2.0' },
    fr: { local: 'woerter-fr.json', pkg: 'an-array-of-french-words@2.0.0' }
};
const dicts = { en: null, de: null, fr: null };
const dictPromises = {};
const CONFUSION_CONF = { en: 90, de: 85, fr: 90 };   // Verwechslungs-Korrektur nur unter dieser Erkennungssicherheit
const EDIT_CONF = { en: 70, de: -1, fr: 65 };        // Einzelbuchstaben-Korrektur (Deutsch aus: Liste zu lückenhaft)
const ALPHA = {
    en: 'abcdefghijklmnopqrstuvwxyz',
    de: 'abcdefghijklmnopqrstuvwxyzäöüß',
    fr: 'abcdefghijklmnopqrstuvwxyzàâçéèêëîïôûùüÿœ'
};
const SIMILAR = [['e', 'c'], ['a', 'o'], ['i', 'l'], ['u', 'v'], ['n', 'h'], ['t', 'f'], ['g', 'q'], ['b', 'h']];
const SKIP_WORDS = new Set(['sb', 'sth', 'qn', 'qc', 'etw', 'jmdn', 'jmd', 'jmdm', 'jdn', 'usw', 'bzw', 'fam', 'lat', 'pl', 'adj', 'adv']);
// Typische OCR-Verwechslungen: [steht im Text, richtig wäre]
const CONFUSIONS = [['m', 'rn'], ['rn', 'm'], ['w', 'vv'], ['vv', 'w'], ['d', 'cl'], ['cl', 'd'], ['h', 'li'], ['li', 'h']];

async function fetchWordArray(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('kein Wort-Array');
    return data;
}
/** 1. lokale Datei im Repo (falls vorhanden), 2. jsDelivr-Paket (JSON-Datei wird per API gesucht) */
async function loadDict(lang) {
    const { local, pkg } = DICT_SOURCES[lang];
    const attempts = [
        () => fetchWordArray(local),
        async () => {
            const res = await fetch(`https://data.jsdelivr.com/v1/packages/npm/${pkg}?structure=flat`);
            const meta = await res.json();
            const file = (meta.files || [])
                .filter((f) => /\.json$/i.test(f.name) && !/package\.json$/i.test(f.name))
                .sort((a, b) => b.size - a.size)[0];
            if (!file) throw new Error('keine JSON-Datei im Paket');
            return fetchWordArray(`https://cdn.jsdelivr.net/npm/${pkg}${file.name}`);
        }
    ];
    for (const attempt of attempts) {
        try {
            return new Set((await attempt()).map((w) => String(w).toLowerCase()));
        } catch (err) {
            console.warn(`Wörterbuch ${lang}: Quelle fehlgeschlagen`, err);
        }
    }
    return null;
}
async function ensureDicts(langs) {
    const state = {};
    await Promise.all(langs.map(async (l) => {
        if (!dictPromises[l]) dictPromises[l] = loadDict(l).then((d) => { dicts[l] = d; return !!d; });
        state[l] = await dictPromises[l];
    }));
    return state;
}

/** Bekannt = im Wörterbuch, auch mit gängiger Endung */
function isKnown(w, lang) {
    const d = dicts[lang];
    if (!d) return true;                       // ohne Wörterbuch nie "unbekannt" behaupten
    if (d.has(w)) return true;
    const suffixes = {
        en: ['s', 'es', 'd', 'ed', 'ing', 'ly', 'er', 'est', 'ness'],
        de: ['e', 'en', 'er', 'es', 'em', 'n', 's', 't', 'te', 'st', 'ten', 'et'],
        fr: ['s', 'x', 'e', 'es']
    }[lang];
    for (const suf of suffixes) {
        if (w.length > suf.length + 2 && w.endsWith(suf)) {
            const stem = w.slice(0, -suf.length);
            if (d.has(stem) || d.has(stem + 'e') || (stem.length > 3 && stem.at(-1) === stem.at(-2) && d.has(stem.slice(0, -1)))) return true;
        }
    }
    if (lang === 'en' && /(ies|ied)$/.test(w) && d.has(w.slice(0, -3) + 'y')) return true;
    return false;
}

/** Alle Varianten eines Wortes mit einer Verwechslungs-Ersetzung (auch zweistufig) */
function variants(word) {
    const one = (w) => {
        const out = new Set();
        for (const [a, b] of CONFUSIONS) {
            let i = w.indexOf(a);
            while (i !== -1) {
                out.add(w.slice(0, i) + b + w.slice(i + a.length));
                i = w.indexOf(a, i + 1);
            }
        }
        return [...out];
    };
    const first = one(word);
    return [...new Set([...first, ...first.flatMap(one)])].filter((v) => v !== word);
}

const isSimilar = (a, b) => strip(a) === strip(b) || SIMILAR.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
function edits1(w, lang) {
    const out = new Map();
    const add = (c, s) => { if (!out.has(c) || out.get(c) > s) out.set(c, s); };
    const A = ALPHA[lang];
    for (let i = 0; i <= w.length; i++) {
        if (i < w.length) {
            add(w.slice(0, i) + w.slice(i + 1), 1);
            for (const ch of A) if (ch !== w[i]) add(w.slice(0, i) + ch + w.slice(i + 1), isSimilar(ch, w[i]) ? 0 : 1);
        }
        for (const ch of A) add(w.slice(0, i) + ch + w.slice(i), 1);
        if (i < w.length - 1) add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2), 1);
    }
    out.delete(w);
    return out;
}

/** Akzent-Index (fehlende Akzente und Umlaute wiederherstellen), nur bei eindeutigem Treffer */
const accentIdx = {};
function accentIndex(lang) {
    if (accentIdx[lang]) return accentIdx[lang];
    const map = new Map();
    for (const w of dicts[lang]) {
        const s = strip(w);
        if (s === w) continue;
        const cur = map.get(s);
        if (cur === undefined) map.set(s, w);
        else if (cur !== w) map.set(s, null);
    }
    accentIdx[lang] = map;
    return map;
}

function suggestWord(word, lang, conf, opts = {}) {
    const d = dicts[lang];
    const w = word.toLowerCase();
    if (!d || w.length < 3 || SKIP_WORDS.has(w) || isProtected(w) || isKnown(w, lang)) return null;

    // 1) rn/m usw.: Ergebnis muss ein echtes Wörterbuchwort sein, genau ein Treffer
    if (conf < CONFUSION_CONF[lang]) {
        const vs = variants(w).filter((v) => d.has(v));
        if (vs.length === 1) return vs[0];
        if (vs.length > 1) return null;
    }
    // 2) fehlende Akzente (Französisch) bzw. Umlaute (Deutsch)
    if ((lang === 'fr' || lang === 'de') && w.length >= 4 && conf < (lang === 'de' ? 90 : 95)) {
        const c = accentIndex(lang).get(w);
        if (c) return c;
    }
    // 3) Einzelbuchstaben-Fehler, nur bei sehr unsicherer Erkennung (nicht beim Stichwort)
    if (!opts.noEdit && w.length >= 5 && conf < EDIT_CONF[lang]) {
        const cands = [...edits1(w, lang)].filter(([c]) => d.has(c));
        if (!cands.length) return null;
        const min = Math.min(...cands.map(([, s]) => s));
        const best = cands.filter(([, s]) => s === min);
        return best.length === 1 ? best[0][0] : null;     // mehrdeutig: nichts ändern
    }
    return null;
}

function matchCase(src, dst) {
    if (src.length > 1 && src === src.toUpperCase()) return dst.toUpperCase();
    if (src[0] !== src[0].toLowerCase()) return dst[0].toUpperCase() + dst.slice(1);
    return dst;
}

function dictCorrect(text, lang, confMap, label, notes, skipProper, skipStem, opts = {}) {
    if (!dicts[lang] || !text) return text;
    return text.replace(/\p{L}+/gu, (tok, offset) => {
        const low = tok.toLowerCase();
        if (skipProper && offset > 0 && tok[0] !== low[0]) return tok;     // Eigennamen
        if (skipStem && low.startsWith(skipStem)) return tok;              // passt zum Stichwort
        const sug = suggestWord(tok, lang, confMap[low] ?? 70, opts);
        if (!sug) return tok;
        const fixed = matchCase(tok, sug);
        notes.push(`Wörterbuch (${label}): „${tok}“ → „${fixed}“`);
        return fixed;
    });
}

/* ================= Kontext: Satz an Stichwort anpassen (Englisch) ================= */
function adaptSentence(e, sentConf, notes) {
    const base = coreWord(e.term);
    if (base.length < 3 || !e.sentence) return;
    const stem = stemOf(base);
    const tokens = [...e.sentence.matchAll(/\p{L}+/gu)];
    if (tokens.some((m) => m[0].toLowerCase().startsWith(stem))) return;   // Stichwort kommt vor: nichts tun

    let best = null;
    for (const m of tokens) {
        const orig = m[0];
        const t = orig.toLowerCase();
        if (t.length < 3 || isProtected(t)) continue;
        const conf = sentConf[t] ?? 70;
        // Nur unsichere bzw. unbekannte Satzwörter dürfen angepasst werden
        const mayChange = dicts.en ? ((!isKnown(t, 'en') && conf < 90) || conf < 60) : conf < 65;
        if (!mayChange) continue;

        let cand = null;
        let d = 99;
        const v = variants(t).find((x) => x.startsWith(stem));
        if (v) { cand = v; d = 0.5; }
        else if (base.length >= 4) {
            const maxD = base.length >= 8 ? 2 : 1;
            for (const L of [base.length - 1, base.length, base.length + 1]) {
                if (L > t.length) continue;
                const dist = levenshtein(t.slice(0, L), base);
                if (dist >= 1 && dist <= maxD && dist < d) { d = dist; cand = base + t.slice(L); }
            }
        }
        if (cand && (!best || d < best.d)) best = { idx: m.index, orig, cand, d };
    }
    if (best) {
        const fixed = matchCase(best.orig, best.cand);
        e.sentence = e.sentence.slice(0, best.idx) + fixed + e.sentence.slice(best.idx + best.orig.length);
        notes.push(`Satz: „${best.orig}“ → „${fixed}“ (an Stichwort angepasst)`);
    }
}

/** Anzahl und Durchschnitt unsicher erkannter Wörter eines Feldes */
/** Hinweise, die der Nutzer prüfen sollte (unsicher gelesen, unbekannte Wörter, fehlende Lücken-Nummern) */
/** unsicher gelesene Wörter eines Feldes (Erkennungssicherheit unter der Schwelle, mit Wörterbuch auch unbekannte Wörter) */
function lowWords(text, map, thr, lang, proper, useProtected) {
    const out = new Set();
    const re = /\p{L}+/gu;
    let m;
    while ((m = re.exec(text))) {
        const tok = m[0];
        const w = tok.toLowerCase();
        if (w.length < 3 || SKIP_WORDS.has(w)) continue;
        const c = map[w];
        if (c === undefined) continue;
        if (c < thr) { out.add(w); continue; }
        if (lang && dicts[lang] && c < 85 && !(proper && m.index > 0 && tok[0] !== w[0])
            && !isKnown(w, lang) && !(useProtected && isProtected(w))) out.add(w);
    }
    return [...out];
}

/** Hinweise, die der Nutzer prüfen sollte */
function computeWarnings(e, lang) {
    const w = [];
    const L = e.lowc || {};
    if (L.term && L.term.length) w.push(`Stichwort unsicher gelesen (${L.term.join(', ')})`);
    if (L.de && L.de.length >= 2) w.push(`Übersetzung unsicher gelesen (${L.de.slice(0, 4).join(', ')})`);
    if (L.sentence && L.sentence.length >= 2) w.push(`Satz unsicher gelesen (${L.sentence.slice(0, 4).join(', ')})`);
    if (lang === 'en' && e.sentence) {
        const stem = stemOf(coreWord(e.term));
        if (stem.length >= 3 && !letters(e.sentence).some((t) => t.startsWith(stem))) w.push('Das Stichwort kommt im Satz nicht vor');
    }
    if (e.gaps && e.gaps.some((g) => g.n == null)) w.push('Lücke ohne erkannte Nummer: Lösung bitte ergänzen');
    return w;
}

function refineEntry(e, confs, lang) {
    const notes = [];
    const labels = { term: 'Stichwort', de: 'Deutsch', sentence: 'Satz' };
    if (lang === 'fr') {      // typografische Apostrophe vereinheitlichen
        e.term = e.term.replace(/[´`‘']/g, '’');
        e.sentence = e.sentence.replace(/[´`‘']/g, '’');
    }
    // Zeichenverwechslungen mitten im Wort (0 → o, 1 oder | → l, großes I → l)
    const fixChars = (s) => s
        .replace(/(\p{L})0(?=\p{L})/gu, '$1o')
        .replace(/(\p{L})[1|](?=\p{L})/gu, '$1l')
        .replace(/(\p{Ll})I(?=\p{Ll})/gu, '$1l');
    for (const key of ['term', 'de', 'sentence']) {
        const fixed = fixChars(e[key]);
        if (fixed !== e[key]) { notes.push(`${labels[key]}: „${e[key]}“ → „${fixed}“`); e[key] = fixed; }
    }
    if (autofixOn()) {
        // Stichwort: nur Verwechslungen und Akzente, die zu einem echten Wörterbuchwort führen
        e.term = dictCorrect(e.term, lang, confs.term, 'Stichwort', notes, false, '', { noEdit: true });
        letters(e.term).forEach((w) => protectedWords.add(w));       // Stichwort ist danach maßgeblich
        if (lang === 'en') adaptSentence(e, confs.sent, notes);
        const stem = lang === 'en' ? stemOf(coreWord(e.term)) : '';
        e.de = dictCorrect(e.de, 'de', confs.de, 'Deutsch', notes, false, '');
        e.sentence = dictCorrect(e.sentence, lang, confs.sent, 'Satz', notes, true, stem);
    }
    if (notes.length) e.fix = notes;
    // unsicher gelesene Wörter merken (werden in den Listen markiert)
    const low = {
        term: lowWords(e.term, confs.term, 65, lang, false, false),
        de: lowWords(e.de, confs.de, 60, 'de', false, true),
        sentence: lowWords(e.sentence, confs.sent, 55, lang, true, true)
    };
    if (low.term.length || low.de.length || low.sentence.length) e.lowc = low;
    const warn = computeWarnings(e, lang);
    if (warn.length) e.warn = warn;
    return e;
}

/* ================= Bilder vorbereiten ================= */
const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

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

function canvasFromBitmap(bmp, sx, sy, sw, sh, targetW) {
    const scale = Math.min(4, Math.max(0.3, targetW / sw));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
}

/** Doppelseite: Spalte mit der geringsten "Tinte" nahe der Mitte (Anteil 0..1) */
function findSplitX(bmp) {
    const c = canvasFromBitmap(bmp, 0, 0, bmp.width, bmp.height, 800);
    const W = c.width, H = c.height;
    const { data } = c.getContext('2d').getImageData(0, 0, W, H);
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 16) hist[Math.round(lumOf(data[i], data[i + 1], data[i + 2]))]++;
    let bg = 0;
    for (let v = 1; v < 256; v++) if (hist[v] > hist[bg]) bg = v;
    const ink = new Float32Array(W);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4;
            if (lumOf(data[o], data[o + 1], data[o + 2]) < bg - 60) ink[x]++;
        }
    }
    let bestX = Math.round(W / 2);
    let bestV = Infinity;
    for (let x = Math.round(W * 0.44); x <= Math.round(W * 0.56); x++) {
        const v = ink[x] + Math.abs(x - W / 2) * 0.02;
        if (v < bestV) { bestV = v; bestX = x; }
    }
    return bestX / W;
}

/** Blauer Seitenkopf (weißer Text auf blauem Balken): Balken finden, separat lesbar machen, danach übermalen */
function extractHeader(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width, h = canvas.height;
    const rows = Math.round(h * 0.18);
    const d = ctx.getImageData(0, 0, w, rows).data;
    const runs = [];
    let run = null;
    for (let y = 0; y < rows; y++) {
        let c = 0;
        for (let x = 0, o = y * w * 4; x < w; x += 2, o += 8) {
            const r = d[o], g = d[o + 1], b = d[o + 2];
            if (b > 110 && b - r > 70 && lumOf(r, g, b) < 150) c++;
        }
        if (c > (w / 2) * 0.5) {
            if (!run) run = { y0: y, y1: y }; else run.y1 = y;
        } else if (run) { runs.push(run); run = null; }
    }
    if (run) runs.push(run);
    const band = runs.filter((r) => r.y1 - r.y0 >= h * 0.012).sort((a, b) => a.y0 - b.y0)[0];
    if (!band) return null;

    const y0 = band.y0 + 2;
    const hh = Math.max(1, band.y1 - band.y0 - 3);
    const img = ctx.getImageData(0, y0, w, hh);
    const px = img.data;
    for (let o = 0; o < px.length; o += 4) {
        const v = lumOf(px[o], px[o + 1], px[o + 2]) > 170 ? 0 : 255;   // heller Text wird schwarz
        px[o] = px[o + 1] = px[o + 2] = v;
        px[o + 3] = 255;
    }
    const hc = document.createElement('canvas');
    hc.width = w;
    hc.height = hh + 40;
    const hctx = hc.getContext('2d');
    hctx.fillStyle = '#fff';
    hctx.fillRect(0, 0, hc.width, hc.height);
    hctx.putImageData(img, 0, 20);

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, band.y1 + 3);      // Balken im Seitenbild entfernen
    return hc;
}

/** Grüne Kästen (grüner Rahmen oben + unten) finden und weiß übermalen */
function maskGreenBoxes(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    const onRow = new Array(h).fill(false);
    for (let y = 0; y < h; y++) {
        let c = 0;
        let o = y * w * 4;
        for (let x = 0; x < w; x++, o += 4) {
            const r = d[o], g = d[o + 1], b = d[o + 2];
            if (g > 120 && g - r > 35 && g - b > 45) c++;
        }
        onRow[y] = c > w * 0.45;
    }
    const lines = [];
    const gap = Math.max(3, Math.round(h * 0.002));
    for (let y = 0; y < h; y++) {
        if (!onRow[y]) continue;
        const last = lines[lines.length - 1];
        if (last && y - last.y1 <= gap) last.y1 = y;
        else lines.push({ y0: y, y1: y });
    }
    let boxes = 0;
    const margin = Math.round(w * 0.012);
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const y0 = Math.max(0, lines[i].y0 - margin);
        const y1 = Math.min(h - 1, lines[i + 1].y1 + 2);
        if (y1 - y0 < 40 || y1 - y0 > h * 0.7) continue;
        ctx.fillRect(0, y0, w, y1 - y0 + 1);
        boxes++;
    }
    return boxes;
}

/** Hintergrund auf Weiß ziehen, Kontrast erhöhen (farbiger Buchhintergrund, feine Tabellenlinien verschwinden) */
function normalizeCanvas(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let o = 0; o < d.length; o += 16) hist[Math.round(lumOf(d[o], d[o + 1], d[o + 2]))]++;
    let bg = 0;
    for (let v = 1; v < 256; v++) if (hist[v] > hist[bg]) bg = v;
    const gain = 255 / Math.max(bg, 120);
    const lo = 90, hi = 200;
    for (let o = 0; o < d.length; o += 4) {
        let v = lumOf(d[o], d[o + 1], d[o + 2]) * gain;
        v = ((v - lo) * 255) / (hi - lo);
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        d[o] = d[o + 1] = d[o + 2] = v;
        d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
}

/** Für Fotos mit Schatten oder ungleichmäßigem Licht: jeden Bereich auf seinen eigenen Hintergrund beziehen */
/** Karte des Papier-Hintergrunds (hellster Wert der Umgebung, Text ist dunkler als das Papier) */
function bgMap(canvas) {
    const w = canvas.width, h = canvas.height;
    const tw = Math.max(8, Math.round(w / 24)), th = Math.max(8, Math.round(h / 24));
    const small = document.createElement('canvas');
    small.width = tw;
    small.height = th;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, tw, th);
    const sd = sctx.getImageData(0, 0, tw, th).data;
    const lum = new Float32Array(tw * th);
    for (let i = 0; i < lum.length; i++) lum[i] = lumOf(sd[i * 4], sd[i * 4 + 1], sd[i * 4 + 2]);
    const R = 3;
    const bgS = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
            let m = 0;
            for (let yy = Math.max(0, y - R); yy <= Math.min(th - 1, y + R); yy++) {
                for (let xx = Math.max(0, x - R); xx <= Math.min(tw - 1, x + R); xx++) {
                    const v = lum[yy * tw + xx];
                    if (v > m) m = v;
                }
            }
            bgS[y * tw + x] = m;
        }
    }
    return { bgS, tw, th, small, sctx };
}
/** Ungleichmäßiges Licht (Schatten, Verlauf): Format spielt keine Rolle, es wird das Bild selbst gemessen */
function isUneven(canvas) {
    const { bgS } = bgMap(canvas);
    const vals = Array.from(bgS).sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.05)];
    const hi = vals[Math.floor(vals.length * 0.95)];
    return hi - lo > 32;
}
/** Jeden Bereich auf seinen eigenen Hintergrund beziehen */
function normalizeLocal(canvas) {
    const w = canvas.width, h = canvas.height;
    const { bgS, tw, th, small, sctx } = bgMap(canvas);
    const bgImg = sctx.createImageData(tw, th);
    for (let i = 0; i < bgS.length; i++) {
        bgImg.data[i * 4] = bgImg.data[i * 4 + 1] = bgImg.data[i * 4 + 2] = bgS[i];
        bgImg.data[i * 4 + 3] = 255;
    }
    sctx.putImageData(bgImg, 0, 0);
    const big = document.createElement('canvas');
    big.width = w;
    big.height = h;
    const bctx = big.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, 0, 0, w, h);
    const bd = bctx.getImageData(0, 0, w, h).data;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const src = ctx.getImageData(0, 0, w, h);
    const d = src.data;
    const lo = 90, hi = 200;
    for (let o = 0; o < d.length; o += 4) {
        const bgv = Math.max(60, bd[o]);
        let v = (lumOf(d[o], d[o + 1], d[o + 2]) / bgv) * 255;
        v = ((v - lo) * 255) / (hi - lo);
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        d[o] = d[o + 1] = d[o + 2] = v;
        d[o + 3] = 255;
    }
    ctx.putImageData(src, 0, 0);
}

/** UK-Flaggen (französische Seiten) finden: kleine Fenster mit viel Marineblau und etwas Rot. Gibt Rechtecke {x, y, w, h} zurück */
function findFlags(d, w, h, refW = w) {
    const W1 = w + 1;
    const red = new Uint32Array(W1 * (h + 1));
    const navy = new Uint32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
        let rr = 0, nn = 0;
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            const r = d[o], g = d[o + 1], b = d[o + 2];
            if (r > 150 && g < 90 && b < 100 && r - g > 80) rr++;
            else if (b > 70 && b < 175 && r < 60 && g < 85 && b - r > 50) nn++;
            const i = (y + 1) * W1 + (x + 1);
            red[i] = red[i - W1] + rr;
            navy[i] = navy[i - W1] + nn;
        }
    }
    const fw = Math.max(16, Math.round(refW * 0.03));        // Flaggenbreite relativ zur Seitenbreite
    const fh = Math.max(10, Math.round(fw * 0.6));
    const step = Math.max(2, Math.floor(fh / 3));
    const area = fw * fh;
    const sum = (arr, x, y) => arr[(y + fh) * W1 + (x + fw)] - arr[y * W1 + (x + fw)] - arr[(y + fh) * W1 + x] + arr[y * W1 + x];
    const rects = [];
    for (let y = 0; y + fh <= h; y += step) {
        for (let x = 0; x + fw <= w; x += step) {
            if (sum(navy, x, y) < area * 0.22 || sum(red, x, y) < area * 0.05) continue;
            const hit = { x, y, w: fw, h: fh };
            const near = rects.find((r) => hit.x < r.x + r.w + fw / 2 && hit.x + hit.w > r.x - fw / 2 && hit.y < r.y + r.h + fh / 2 && hit.y + hit.h > r.y - fh / 2);
            if (near) {
                const x0 = Math.min(near.x, hit.x), y0 = Math.min(near.y, hit.y);
                const x1 = Math.max(near.x + near.w, hit.x + hit.w), y1 = Math.max(near.y + near.h, hit.y + hit.h);
                near.x = x0; near.y = y0; near.w = x1 - x0; near.h = y1 - y0;
            } else rects.push(hit);
        }
    }
    return rects;
}
/** Flagge und das daneben stehende englische Wort übermalen */
function maskFlags(ctx, w, h) {
    const rw = Math.round(w * 0.45);                           // Flaggen stehen links neben den Stichwörtern
    const d = ctx.getImageData(0, 0, rw, h).data;
    const flags = findFlags(d, rw, h, w);
    ctx.fillStyle = '#ffffff';
    flags.forEach((f) => {
        const x0 = Math.max(0, f.x - 4);
        const y0 = Math.max(0, f.y - Math.round(f.h * 0.3));
        const x1 = Math.min(w, f.x + f.w + Math.round(f.w * 6.5));
        const y1 = Math.min(h, f.y + Math.round(f.h * 1.3));
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    });
    return flags.length;
}

/** Bild laden; Formate, die createImageBitmap nicht kennt, werden über ein Bildelement geladen und intern in ein Canvas umgewandelt */
async function loadBitmap(file) {
    try {
        return await createImageBitmap(file);
    } catch (e) { /* weiter mit Bildelement */ }
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error('Dieses Bildformat wird vom Browser nicht unterstützt. Bitte als PNG oder JPEG speichern.'));
            i.src = url;
        });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        return await createImageBitmap(c);
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** Leichtes Nachschärfen nach dem Hochskalieren (macht Buchstabenkanten klarer) */
function sharpenCanvas(canvas, amount) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width, h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = d[o];
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const avg = (g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) / 4;
            const v = g[i] + amount * (g[i] - avg);
            const o = i * 4;
            d[o] = d[o + 1] = d[o + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
    }
    ctx.putImageData(img, 0, 0);
}

/** Schräglage eines Fotos schätzen (Grad, 0 = gerade): Textzeilen sind gerade, wenn die Zeilenprofile am schärfsten sind */
function estimateSkew(canvas) {
    const scale = Math.min(1, 700 / canvas.width);
    const w = Math.max(8, Math.round(canvas.width * scale));
    const h = Math.max(8, Math.round(canvas.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(canvas, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;
    const hist = new Uint32Array(256);
    for (let o = 0; o < d.length; o += 16) hist[Math.round(lumOf(d[o], d[o + 1], d[o + 2]))]++;
    let bg = 0;
    for (let v = 1; v < 256; v++) if (hist[v] > hist[bg]) bg = v;
    const pts = [];
    const step = Math.max(1, Math.floor((w * h) / 90000));
    for (let i = 0; i < w * h; i += step) {
        const o = i * 4;
        if (lumOf(d[o], d[o + 1], d[o + 2]) < bg - 70) pts.push(i % w, Math.floor(i / w));
    }
    if (pts.length < 400) return 0;
    const score = (deg) => {
        const t = (deg * Math.PI) / 180;
        const s = Math.sin(t), co = Math.cos(t);
        const bins = new Float32Array(h + w + 2);
        for (let k = 0; k < pts.length; k += 2) bins[Math.round(pts[k + 1] * co - pts[k] * s + w)]++;
        let ss = 0;
        for (let b = 0; b < bins.length; b++) ss += bins[b] * bins[b];
        return ss;
    };
    const base = score(0);
    let best = 0;
    let bestS = base;
    for (let a = -4; a <= 4.001; a += 0.5) { const s2 = score(a); if (s2 > bestS) { bestS = s2; best = a; } }
    const center = best;
    for (let a = center - 0.4; a <= center + 0.41; a += 0.1) { const s2 = score(a); if (s2 > bestS) { bestS = s2; best = a; } }
    return Math.abs(best) >= 0.4 && bestS > base * 1.03 ? best : 0;
}
function rotateCanvas(canvas, deg) {
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((-deg * Math.PI) / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out;
}

/** Ein Bild ergibt 1 oder 2 Seiten (Doppelseiten werden geteilt) */
/** Ein Bild ergibt 1 oder 2 Seiten (Doppelseiten werden geteilt). Alle Formate (PNG, JPEG, WebP ...) werden gleich behandelt. */
async function preparePages(file, lang) {
    const bmp = await loadBitmap(file);
    try {
        const splitEl = $('autosplit');
        const allowSplit = !splitEl || splitEl.checked;
        let rects = [[0, bmp.width]];
        if (allowSplit && bmp.width / bmp.height > 1.25) {
            const sx = Math.round(findSplitX(bmp) * bmp.width);
            rects = [[0, sx], [sx, bmp.width - sx]];
        }
        const pages = [];
        let boxes = 0;
        let flags = 0;
        for (const [x, w] of rects) {
            let canvas = canvasFromBitmap(bmp, x, 0, w, bmp.height, 2200);
            const skew = estimateSkew(canvas);
            if (skew) canvas = rotateCanvas(canvas, skew);
            const header = extractHeader(canvas);
            const cctx = canvas.getContext('2d', { willReadFrequently: true });
            boxes += maskGreenBoxes(cctx, canvas.width, canvas.height);
            if (lang === 'fr') flags += maskFlags(cctx, canvas.width, canvas.height);
            if (isUneven(canvas)) normalizeLocal(canvas); else normalizeCanvas(canvas);
            sharpenCanvas(canvas, 0.55);
            pages.push({ canvas, header });
        }
        return { pages, boxes, flags };
    } finally {
        bmp.close();
    }
}

/* ================= Upload & OCR ================= */
function readPathFields() { return [1, 2, 3].map((i) => $(`path-${i}`).value.trim()); }
function makeContext() {
    const l = readPathFields();
    return { l, manual: l.some(Boolean), auto: $('autodetect').checked, seen: new Set() };
}

async function handleBatchUpload(files) {
    files = [...files].filter((f) => (f.type || '').startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|heic|heif|tiff?)$/i.test(f.name || ''));
    if (!files.length || isScanning) return;
    if (typeof Tesseract === 'undefined') {
        setStatus('Fehler: Texterkennung konnte nicht geladen werden (Internet prüfen).', 'error');
        return;
    }

    isScanning = true;
    showPreviews(files);
    const lang = currentLang;
    const L = LANGS[lang];
    let dictState = {};
    if (autofixOn()) {
        setStatus('Lade Wörterbücher (einmalig, einige MB)...');
        dictState = await ensureDicts(L.dict);
    }
    setStatus('Initialisiere Texterkennung (beim ersten Mal ein größerer Download)...');

    const ctx = makeContext();
    let step = '';
    let failed = 0, added = 0, solved = 0, boxes = 0, flags = 0, suggested = 0;
    let worker;
    try {
        worker = await Tesseract.createWorker(L.ocr, 1, {
            logger: (m) => {
                if (m.status === 'recognizing text') setStatus(`${step}: ${Math.round(m.progress * 100)} %`);
            }
        });
        try { await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' }); } catch (e) { /* optional */ }
        for (let i = 0; i < files.length; i++) {
            step = `Bild ${i + 1}/${files.length}`;
            setStatus(`Bereite ${step} vor...`);
            try {
                const prep = await preparePages(files[i], lang);
                boxes += prep.boxes;
                flags += prep.flags;
                for (let p = 0; p < prep.pages.length; p++) {
                    const page = prep.pages[p];
                    step = `Bild ${i + 1}/${files.length}${prep.pages.length > 1 ? `, Seite ${p + 1}/${prep.pages.length}` : ''}`;
                    const { data } = await worker.recognize(page.canvas);
                    let headerText = '';
                    if (page.header) {
                        try { headerText = (await worker.recognize(page.header)).data.text || ''; } catch (e) { /* ohne Seitenkopf weiter */ }
                    }
                    const res = parsePage(data.words || [], page.canvas.width, headerText, ctx, lang, page.canvas.height);
                    added += addEntries(res.entries, lang);
                    solved += applySolutions(res.solutions, lang);
                }
            } catch (err) {
                failed++;
                console.error(`Fehler bei Bild ${i + 1}:`, err);
            }
        }
    } catch (err) {
        console.error(err);
        setStatus('Fehler: Die Texterkennung konnte nicht gestartet werden.', 'error');
        isScanning = false;
        return;
    } finally {
        if (worker) await worker.terminate();
    }

    if (lang === 'fr' && autofixOn() && dicts.fr) suggested = fillGapSuggestions('fr');
    isScanning = false;
    refreshAll();
    const dictNote = autofixOn() && L.dict.some((l) => !dictState[l]) ? ' Wörterbuch nicht vollständig geladen, Korrektur eingeschränkt.' : '';
    const warnN = vocabularyPool.filter((v) => v.lang === lang && v.warn && v.warn.length).length;
    if (added) {
        const areas = [...ctx.seen].slice(0, 6).join(', ') || 'keine erkannt';
        setStatus(`${added} neue Vokabeln erkannt${solved ? `, ${solved} Lücken-Lösungen zugeordnet` : ''}${boxes ? `, ${boxes} Kasten entfernt` : ''}${flags ? `, ${flags} Flaggen entfernt` : ''}${suggested ? `, ${suggested} Lücken-Lösungen vorgeschlagen` : ''}${failed ? `, ${failed} Bild(er) fehlgeschlagen` : ''}. Bereiche: ${areas}.${dictNote}${warnN ? ` ${warnN} Einträge sind als „Bitte prüfen“ markiert (unter „Listen“ filterbar).` : ''}`, 'ok');
    } else {
        setStatus(`Keine neuen Vokabeln erkannt${failed ? ` (${failed} Bild(er) fehlgeschlagen)` : ''}. Prüfe, ob die richtige Sprache oben gewählt ist, und nutze gut lesbare Seiten mit 3 Spalten.`, 'error');
    }
}

function makeItem(e, lang) {
    return sanitizePool([{ ...e, id: uid(), lang }])[0] || null;
}
function addEntries(entries, lang) {
    let added = 0;
    entries.forEach((e) => {
        const item = makeItem(e, lang);
        if (!item) return;
        const dup = vocabularyPool.find((v) => sameVocab(v, item));
        if (!dup) { vocabularyPool.push(item); added++; return; }
        // gleiche Vokabel zum zweiten Mal erkannt (z. B. überlappende Screenshots): die sicherere Version behalten
        if (dup.warn && dup.warn.length && !(item.warn && item.warn.length)) {
            dup.de = item.de;
            dup.sentence = item.sentence;
            if (!dup.gaps.some((g) => g.a)) dup.gaps = item.gaps;
            if (item.path.length) dup.path = item.path;
            dup.fix = item.fix;
            dup.warn = undefined;
        }
    });
    rebuildProtected();
    savePool();
    return added;
}
/** Lösungen aus den Zahlen-Kästen den Lücken zuordnen (gleicher Bereich, gleiche Nummer) */
function applySolutions(solutions, lang) {
    let n = 0;
    solutions.forEach(({ key, map }) => {
        vocabularyPool.forEach((v) => {
            if (v.lang !== lang || v.path.join(' › ') !== key) return;
            v.gaps.forEach((g) => {
                if ((g.a && !g.auto) || g.n == null || !map[g.n]) return;     // automatische Vorschläge dürfen überschrieben werden
                let a = map[g.n];
                if (lang === 'fr' && dicts.fr) a = dictCorrect(a, 'fr', {}, 'Lösung', [], false, '');
                g.a = a;
                g.auto = false;
                g.alts = [];
                n++;
            });
            if (v.warn && !v.gaps.some((g) => g.auto)) {
                v.warn = v.warn.filter((x) => x !== AUTO_MSG);
                if (!v.warn.length) v.warn = undefined;
            }
        });
    });
    if (n) savePool();
    return n;
}

/* ================= Tabellen-Parser (3 Spalten) ================= */
const PHON_CHARS = /[ˈˌːəɪʊɒʌæðθʃʒŋɑɔɜɛɡʁɥɲøʔʎ\u0303]/;
const ARROW_RE = /[→↔⇒⇔⟶⟷]|<\s*[-–—=]{1,3}\s*>|<\s*>|[-–—=]{1,3}\s*>|<\s*[-–—=]{1,3}/;
const GRAM_TAGS = /^(?:fam\.|m\.\/f\.|m\.|f\.|adj\.|adv\.|pl\.|m\.pl\.|f\.pl\.|sg\.|\+inf\.|\+)$/i;
const SUP = { '⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9 };
const supToNum = (s) => Number([...s].map((ch) => (ch in SUP ? SUP[ch] : ch)).join(''));

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

/** Spaltenanfänge: die 3 häufigsten Zeilenanfangs-Positionen (Histogramm-Spitzen) */
function findColumnStarts(words, pageW, medH) {
    const starts = [];
    groupLines(words, medH).forEach((line) => {
        starts.push(line.words[0].x0);
        for (let i = 1; i < line.words.length; i++) {
            if (line.words[i].x0 - line.words[i - 1].x1 > pageW * 0.02) starts.push(line.words[i].x0);
        }
    });
    const bins = new Array(101).fill(0);
    starts.forEach((x) => { bins[Math.min(100, Math.max(0, Math.round((x / pageW) * 100)))]++; });
    const work = bins.map((_, i) => (bins[i - 1] || 0) + bins[i] + (bins[i + 1] || 0));
    const peaks = [];
    for (let k = 0; k < 3; k++) {
        let bi = 0;
        for (let i = 1; i < work.length; i++) if (work[i] > work[bi]) bi = i;
        if (work[bi] < 3) break;
        peaks.push(bi);
        for (let i = Math.max(0, bi - 9); i <= Math.min(100, bi + 9); i++) work[i] = 0;
    }
    if (peaks.length < 3) return null;
    peaks.sort((a, b) => a - b);
    return peaks.map((p) => {
        const near = starts.filter((x) => Math.abs((x / pageW) * 100 - p) <= 3);
        return near.length ? median(near) : (p / 100) * pageW;
    });
}

/** Stichwort ohne Lautschrift, Grammatikkürzel und Marker */
function parseHeadword(raw, lang) {
    const tokens = raw.replace(/^[\s\d*.]+/, '').split(/\s+/).filter(Boolean);
    while (tokens.length && /^\(.{0,3}\)$/.test(tokens[0])) tokens.shift();     // Marker wie "(é)"
    const hasBracket = tokens.some((t) => t.includes('['));
    const startRe = lang === 'fr' ? /^[[{|,;ˈˌ]/ : /^[[({|,;'’ˈˌ]/;
    const kept = [];
    for (const tok of tokens) {
        const br = tok.indexOf('[');
        if (br > 0) { kept.push(tok.slice(0, br)); break; }
        // "(song)" oder "(pl)" sind Teil des Stichworts, wenn die Lautschrift sicher in [ ] steht
        const plainParen = hasBracket && /^\([\p{L}-]+\)?$/u.test(tok);
        if ((!plainParen && startRe.test(tok)) || /\]$/.test(tok) || PHON_CHARS.test(tok) || /\w:|:\w/.test(tok)) break;
        // verirrtes "I" oder "!" (rotes Ausrufezeichen) direkt nach einem Schrägstrich
        const prev = kept[kept.length - 1];
        if (prev && /\/$/.test(prev) && /^[I|!l1]$/.test(tok)) continue;
        kept.push(tok.replace(/,$/, ''));
        if (/,$/.test(tok)) break;
    }
    return kept.filter((t) => !GRAM_TAGS.test(t)).join(' ')
        .replace(/\((?:no\s+)?pl\.?\)/gi, ' ')
        .replace(/[^\p{L}\s/.'’()-]/gu, '')
        .replace(/\s*\/\s*/g, ' / ')
        .replace(/\s+/g, ' ')
        .replace(/[.\s]+$/, '')
        .trim();
}

/** Deutsch: Bindestrich am Zeilenende = Silbentrennung (Folgezeile klein); vor Großbuchstaben bleibt er (Hochhaus-Siedlung) */
function joinHyphenated(lines) {
    let out = '';
    for (const l of lines) {
        if (out.endsWith('-') && /^\p{Ll}/u.test(l)) out = out.slice(0, -1) + l;
        else if (out.endsWith('-')) out += l;
        else out += (out ? ' ' : '') + l;
    }
    return out.replace(/\s+/g, ' ').trim();
}
/** Englisch/Französisch: "porte-" + "monnaie" bleibt "porte-monnaie", ein losgelöstes "-" ist eine Lücke */
function joinFrench(lines) {
    let out = '';
    for (const l of lines) out = /\p{L}-$/u.test(out) ? out + l : out + (out ? ' ' : '') + l;
    return out.replace(/\s+/g, ' ').trim();
}

/** Satzzeichen sauber setzen (OCR trennt sie oft durch Leerzeichen ab) */
function fixPunct(s) {
    return s
        .replace(/\s+([.,;:!?%)\]”’])/g, '$1')
        .replace(/([(\[“‘„])\s+/g, '$1')
        .replace(/([,;!?])(?=\p{L})/gu, '$1 ')
        .replace(/(\p{Ll})\.(?=\p{Lu}\p{Ll})/gu, '$1. ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Beispielsatz = Zeilen bis zum ersten Zusatz (Fr./Lat., Pfeile, "x = y", "Stichwort – Erklärung" nach dem Satz) */
function extractSentence(lines, lang, term) {
    const stem = stemOf(coreWord(term || '')).slice(0, 6);
    const startsWithTerm = (left) => {
        if (stem.length < 3) return false;
        const first = normAns(left).split(' ')[0] || '';
        return first.startsWith(stem);
    };
    const isRelation = (l) => {
        let m = l.match(/^([^=→↔←–—~]{1,40}?)\s*(?:=|→|↔|←|–|—|~|<->|->|<-)\s*\S/u);
        if (!m) m = l.match(/^(.{1,40}?)\s-\s\S/u);
        return !!m && startsWithTerm(m[1]);
    };
    const out = [];
    for (const l of lines) {
        if (/^(Fr|Lat)\.?\s/i.test(l) || ARROW_RE.test(l)) break;
        if (out.length && (/\s=\s/.test(l) || isRelation(l))) break;
        out.push(l);
    }
    return fixPunct(joinFrench(out));
}

/** Lücken des Buchs ("-" + hochgestellte Nummer) werden zu "_____", die Nummern werden gemerkt */
function convertGaps(sentence) {
    const toks = sentence.split(/\s+/).filter(Boolean);
    const out = [];
    const gaps = [];
    let lastNoNum = null;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (lastNoNum && (/^[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/.test(t) || /^\d{1,2}$/.test(t))) {
            lastNoNum.n = supToNum(t);       // Nummer wurde als eigenes Wort erkannt
            lastNoNum = null;
            continue;
        }
        lastNoNum = null;
        // Lückenzeichen: Bindestrich, Gedankenstrich oder Tilde, danach oft die hochgestellte Nummer
        const m = t.match(/^((?:\S*?['’])?)([-–—‑−~˜∼]+)([⁰¹²³⁴⁵⁶⁷⁸⁹]+|\d{1,2})?([.,;:!?»”)"]*)$/);
        if (m) {
            const [, prefix, dashes, num, trail] = m;
            const plain = /^[-‑−~˜∼]+$/.test(dashes);
            const prevEnds = i === 0 || /[.?!»"”:]$/.test(toks[i - 1]);
            // Ein alleinstehender Gedankenstrich (– / —) am Satzanfang oder nach Satzende ist ein Dialogstrich, keine Lücke
            if (num || plain || prefix || !prevEnds) {
                const gap = { n: num ? supToNum(num) : null, a: '', auto: false, alts: [] };
                gaps.push(gap);
                if (!num) lastNoNum = gap;
                out.push(`${prefix}${GAP}${trail}`);
                continue;
            }
        }
        out.push(t);
    }
    return { text: fixPunct(out.join(' ')), gaps };
}

/** "hier:" (auch als "hier." erkannt), Verweise wie "▶ Verbes, p. 158" und Konjugationshinweise weglassen */
function cleanGerman(s) {
    return s
        .replace(/(^|[;,]\s*|\.\s+)hier\s*[:.;,]\s*/gi, '$1')
        .replace(/\s*[▶►]\s*[^;]*$/u, '')
        .replace(/\s*[▶►]?\s*\p{Lu}\p{L}+,\s*p\.\s*\d+\s*$/u, '')
        .replace(/\bwird wie \p{L}+ konjugiert\b/giu, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s;,.:]+|[\s;,.:]+$/g, '')
        .trim();
}

const ABBR = new Set(['jdn', 'jdm', 'jmdn', 'jmdm', 'jmd', 'etw', 'usw', 'bzw', 'ca', 'sth', 'sb', 'etc', 'fr', 'lat', 'pl', 'sg', 'adj', 'adv',
    'vs', 'nr', 'dr', 'mr', 'mrs', 'ms', 'st', 'bspw', 'ggf', 'evtl', 'inkl', 'vgl', 'sog', 'od', 'gen', 'dat', 'akk', 'konj', 'inf', 'tel', 'str']);
/** Punkt und Komma besser unterscheiden: Ein Punkt mitten im Satz vor einem Kleinbuchstaben ist ein Komma, ein Komma am Satzende ein Punkt */
function fixPeriodsCommas(s, kind) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c !== '.' && c !== ',') { out += c; continue; }
        const prev = s[i - 1] || '';
        const next = s[i + 1] || '';
        if (c === '.') {
            if (next === '.' || prev === '.') { out += c; continue; }                       // Auslassungspunkte
            if (/\d/.test(prev) && /\d/.test(next)) { out += c; continue; }                  // Dezimalzahl
            const word = ((s.slice(0, i).match(/(\p{L}+)$/u)) || [])[1] || '';
            const lw = word.toLowerCase();
            if (ABBR.has(lw) || lw.length === 1) { out += c; continue; }                    // Abkürzungen, z. B., d. h.
            if (next === ' ' && /^\p{Ll}/u.test(s.slice(i + 2))) { out += ','; continue; }  // Punkt mitten im Satz
            out += c;
        } else {
            if (kind === 'sentence' && s.slice(i + 1).trim() === '') { out += '.'; continue; }   // Komma am Satzende
            out += c;
        }
    }
    return out;
}

/** Buchstabiert geschriebene Kopfzeile ("U N I T É 1") zusammenziehen */
function collapseSpaced(text) {
    const toks = text.split(/\s+/).filter(Boolean);
    const singles = toks.filter((t) => t.length === 1).length;
    if (toks.length >= 4 && singles / toks.length >= 0.6) return toks.join('');
    return text;
}

/** Französisch: Zeilen unter dem Stichwort, die mit einer Flagge (als Zeichen erkannt) und englischem Wort oder mit =, ≠, → beginnen, gehören nicht zum Stichwort */
function cutHeadwordLines(lines) {
    if (!lines.length) return lines;
    const out = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (/^[≠=→<>~≈↔]/.test(l)) break;
        const t = l.split(/\s+/);
        if (t.length >= 2 && t[0].length <= 3 && !/\p{Ll}/u.test(t[0])) break;
        out.push(l);
    }
    return out;
}

/* ---- Überschriften (Gliederung) ----
   Hauptbereiche (Ebene 1): Unité, Unit, Module, Across cultures, Focus
   Unterbereiche (Ebene 2): Volet, Mots en contexte, Texts, Introduction, Section */
const HEAD_PATTERNS = [
    { re: /unit[ée]\s*(\d{1,2})\b/i, level: 0, name: (m) => `Unité ${m[1]}` },
    { re: /\bunit\s*(\d{1,2})\b/i, level: 0, name: (m) => `Unit ${m[1]}` },
    { re: /\bmodule\s*([a-z0-9])\b/i, level: 0, name: (m) => `Module ${m[1].toUpperCase()}` },
    { re: /\bacross\s+cult\w{2,6}\s*(\d{1,2})\b/i, level: 0, name: (m) => `Across cultures ${m[1]}` },
    { re: /\bf[o0]cus\s*(\d{1,2})\b/i, level: 0, name: (m) => `Focus ${m[1]}` },
    { re: /\bvolet\s*(\d{1,2})\b/i, level: 1, name: (m) => `Volet ${m[1]}` },
    { re: /\bmots en contexte\b/i, level: 1, name: () => 'Mots en contexte' },
    { re: /\btexts?\s*([a-z0-9])\b/i, level: 1, name: (m) => `Texts ${m[1].toUpperCase()}` },
    { re: /\bintroduction\b/i, level: 1, name: () => 'Introduction' },
    { re: /\bsection\s*([a-z0-9])\b/i, level: 1, name: (m) => `Section ${m[1].toUpperCase()}` }
];
function parseHeading(text) {
    const t = String(text).replace(/[|¦│]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 90) return [];
    const found = [];
    HEAD_PATTERNS.forEach((p) => {
        const m = t.match(p.re);
        if (m) found.push({ idx: m.index, level: p.level, name: p.name(m) });
    });
    return found.sort((a, b) => a.idx - b.idx);
}
function applyHeadings(ctx, items) {
    items.forEach((h) => {
        ctx.l[h.level] = h.name;
        for (let k = h.level + 1; k < 3; k++) ctx.l[k] = '';
    });
}

/* ---- Lösungskästen ("1 s'allume 2 rejoins ...") ---- */
function isSolutionLine(l, medH) {
    const nums = [];
    l.words.forEach((w) => { if (/^\d{1,2}$/.test(w.t)) nums.push(Number(w.t)); });
    if (nums.length < 2) return false;
    const consecutive = nums.some((n, i) => nums.indexOf(n + 1) > i);
    if (!consecutive) return false;
    const small = median(l.words.map((w) => w.y1 - w.y0)) < medH * 0.92;
    return nums.length >= 3 || small;
}
function parseSolutions(tokens) {
    const map = {};
    let cur = null;
    let expected = null;
    for (const tok of tokens) {
        if (/^\d{1,2}$/.test(tok) && (expected === null || Number(tok) === expected)) {
            cur = Number(tok);
            expected = cur + 1;
            map[cur] = [];
        } else if (cur !== null) {
            map[cur].push(tok);
        }
    }
    const out = {};
    Object.keys(map).forEach((k) => {
        const t = map[k].join(' ').replace(/\s+/g, ' ').trim();
        if (t) out[k] = t;
    });
    return out;
}

function parsePage(rawWords, pageW, headerText, ctx, lang, pageH) {
    const result = { entries: [], solutions: [] };
    const all = rawWords
        .map((w) => ({ t: (w.text || '').trim(), c: w.confidence, x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1 }))
        .filter((w) => w.t && !/^[!|•·▶►◀◄]+$/.test(w.t) && !(w.c < 15 && w.t.length <= 2));
    if (all.length < 6) return result;
    all.forEach((w) => { w.yc = (w.y0 + w.y1) / 2; });
    const medH = median(all.map((w) => w.y1 - w.y0));

    // Laufender Seitenkopf aus dem blauen Balken: nur als Startkontext (Zwischenüberschriften haben Vorrang)
    if (ctx.auto && !ctx.manual && headerText) {
        const hs = parseHeading(collapseSpaced(headerText.replace(/\s+/g, ' ')));
        const l1 = hs.find((h) => h.level === 0);
        const empty = !ctx.l.some(Boolean);
        if (hs.length && (empty || (l1 && l1.name !== ctx.l[0]))) applyHeadings(ctx, hs);
    }

    let starts = findColumnStarts(all, pageW, medH);
    if (!starts) return result;
    // Rote Ausrufezeichen-Marker links von Spalte 3 entfernen (OCR liest sie oft als I, l, 1 oder |)
    const isMarker = (w) => w.t.length === 1 && /[Il1|!]/.test(w.t) && w.x1 < starts[2]
        && starts[2] - w.x0 < pageW * 0.06 && w.x0 > starts[1] + pageW * 0.1;
    const words = all.filter((w) => !isMarker(w));
    starts = findColumnStarts(words, pageW, medH) || starts;
    const margin = pageW * 0.012;
    const colOf = (w) => (w.x0 >= starts[2] - margin ? 2 : w.x0 >= starts[1] - margin ? 1 : 0);

    const events = [];
    const skip = new Set();
    const pageLines = groupLines(words, medH);

    // Laufschrift: Kopfzeile (Großbuchstaben, "UNITÉ 1 | VOLET 2", "MODULE A") und Fußzeile mit Seitenzahl ("168 cent-soixante-huit") gehören nicht zu den Vokabeln
    if (pageH) {
        const zoneTop = pageH * 0.075;
        const zoneBottom = pageH * 0.925;
        pageLines.forEach((l) => {
            const text = collapseSpaced(l.text);
            if (l.yc < zoneTop) {
                const lt = text.replace(/[^\p{L}]/gu, '');
                const items = parseHeading(text);
                if ((lt.length >= 4 && lt === lt.toUpperCase()) || items.length) {
                    l.words.forEach((w) => skip.add(w));
                    if (items.length && ctx.auto && !ctx.manual && !ctx.l.some(Boolean)) events.push({ y: -1, type: 'head', items });
                }
            } else if (l.yc > zoneBottom && l.words.length <= 6 && /(^|\s)\d{1,3}(\s|$)/.test(text)) {
                l.words.forEach((w) => skip.add(w));
            }
        });
    }

    // Lösungskästen erkennen und aus der Tabelle nehmen
    const blocks = [];
    let block = null;
    pageLines.forEach((l) => {
        if (l.words.some((w) => skip.has(w)) || !isSolutionLine(l, medH)) return;
        if (block && l.yc - block.last < medH * 2.4) { block.lines.push(l); block.last = l.yc; }
        else { block = { lines: [l], last: l.yc }; blocks.push(block); }
    });
    blocks.forEach((b) => {
        b.lines.forEach((l) => l.words.forEach((w) => skip.add(w)));
        const map = parseSolutions(b.lines.flatMap((l) => l.words.map((w) => w.t)));
        if (Object.keys(map).length) events.push({ y: b.lines[0].yc, type: 'sol', map });
    });

    // Überschriften: Zeilen, die ganz in Spalte 1 stehen oder deutlich größer gedruckt sind (breite Titel wie "Across cultures 1 ...")
    pageLines.forEach((l) => {
        if (l.words.some((w) => skip.has(w)) || l.words.length > 10) return;
        const items = parseHeading(collapseSpaced(l.text));
        if (!items.length) return;
        const allCol0 = l.words.every((w) => colOf(w) === 0);
        const big = median(l.words.map((w) => w.y1 - w.y0)) >= medH * 1.15;
        if (!(allCol0 || big)) return;
        l.words.forEach((w) => skip.add(w));
        events.push({ y: l.yc, type: 'head', items });
    });

    const body = words.filter((w) => !skip.has(w));
    const cols = [[], [], []];
    body.forEach((w) => cols[colOf(w)].push(w));
    const [l1, l2, l3] = cols.map((c) => groupLines(c, medH));

    // Zeilenanfänge: Spalte-1-Zeile, die mit Spalte 2/3 oben bündig ist und Abstand zur Vorzeile hat
    const tol = medH * 0.7;
    const anchors = [];
    l1.forEach((l, i) => {
        const aligned = [...l2, ...l3].some((o) => Math.abs(o.yc - l.yc) <= tol);
        const gapOk = i === 0 || l.yc - l1[i - 1].yc > medH * 1.7;
        if (aligned && gapOk && parseHeadword(l.text, lang).length >= 2) anchors.push(l);
    });

    const collect = (colLines, row) => {
        const out = [];
        let prev = row.a.yc;
        for (const l of colLines) {
            if (l.yc < row.top || l.yc >= row.end) continue;
            if (l.yc - prev > medH * 3) break;
            out.push(l.text.replace(/\s+/g, ' ').trim());
            prev = l.yc;
        }
        return out;
    };

    anchors.forEach((a, i) => {
        const row = { a, top: a.yc - tol, end: anchors[i + 1] ? anchors[i + 1].yc - tol : Infinity };
        const termLines = collect(l1, row);
        const term = parseHeadword((lang === 'fr' ? cutHeadwordLines(termLines) : termLines).join(' '), lang);
        // Deutsche Übersetzung: alle Zeilen und alle Bedeutungen, aber ohne "hier:"
        const deLines = collect(l2, row).map((l) => l.replace(/^hier\s*[:.;,]\s*/i, ''));
        const de = fixPeriodsCommas(cleanGerman(fixPunct(joinHyphenated(deLines).replace(/[|!•]/g, ''))), 'de');
        const rawSent = extractSentence(collect(l3, row), lang, term).replace(/\|/g, 'I');
        const conv = lang === 'fr' ? convertGaps(rawSent) : { text: rawSent, gaps: [] };
        conv.text = fixPeriodsCommas(conv.text, 'sentence');
        const okTerm = /^\(?\p{L}/u.test(term) && term.split(' ').length <= 11;
        const okSent = lang === 'fr' || conv.text.length > 5;   // französische Einträge dürfen ohne Satz sein
        if (!(okTerm && de.length > 1 && okSent)) return;

        const inRow = (arr) => arr.filter((w) => w.yc >= row.top && w.yc < row.end);
        const confMap = (arr) => {
            const m = {};
            inRow(arr).forEach((w) => {
                const c = w.c ?? 100;
                (w.t.toLowerCase().match(/\p{L}+/gu) || []).forEach((k) => { m[k] = Math.min(m[k] ?? 100, c); });
            });
            return m;
        };
        const confs = { term: confMap(cols[0]), de: confMap(cols[1]), sent: confMap(cols[2]) };
        events.push({ y: a.yc, type: 'entry', entry: refineEntry({ term, de, sentence: conv.text, gaps: conv.gaps }, confs, lang) });
    });

    // Von oben nach unten durchgehen: Überschriften ändern den Bereich für die folgenden Einträge
    events.sort((x, y) => x.y - y.y);
    for (const ev of events) {
        if (ev.type === 'head') {
            if (ctx.auto) applyHeadings(ctx, ev.items);
        } else if (ev.type === 'sol') {
            result.solutions.push({ key: ctx.l.filter(Boolean).join(' › '), map: ev.map });
        } else {
            ev.entry.path = ctx.l.filter(Boolean);
            ctx.seen.add(ev.entry.path.join(' › ') || 'Ohne Bereich');
            result.entries.push(ev.entry);
        }
    }
    return result;
}

/* ================= Kamera ================= */
let camStream = null;
let camShots = [];

async function openCamera() {
    const dlg = $('camera-dialog');
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || typeof dlg.showModal !== 'function') {
        $('cam-input').click();
        return;
    }
    try {
        camStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
            audio: false
        });
    } catch (e) {
        setStatus('Kamera-Zugriff nicht möglich, die Foto-App wird geöffnet.', 'busy');
        $('cam-input').click();
        return;
    }
    camShots = [];
    $('cam-count').textContent = '0 Fotos';
    $('camera-video').srcObject = camStream;
    dlg.showModal();
}
function stopCamera() {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    $('camera-video').srcObject = null;
}
async function takeShot() {
    const v = $('camera-video');
    if (!v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) return;
    camShots.push(new File([blob], `foto-${camShots.length + 1}.jpg`, { type: 'image/jpeg' }));
    $('cam-count').textContent = `${camShots.length} Foto${camShots.length === 1 ? '' : 's'}`;
}

/* ================= Prüflogik ================= */
/** Lückentext (Englisch ohne Buchlücken): ersetzt das (auch gebeugte) Lernwort im Satz */
function makeGap(item) {
    if (item.lang !== 'en' || !item.sentence) return null;
    const base = coreWord(item.term);
    if (!base || base.length < 2) return null;
    const src = `\\b${escapeRe(stemOf(base))}\\p{L}*`;
    const m = item.sentence.match(new RegExp(src, 'iu'));
    if (!m) return null;
    return { text: item.sentence.replace(new RegExp(src, 'giu'), GAP), match: m[0].toLowerCase() };
}
const countGaps = (s) => (s.match(/_____/g) || []).length;
const numberGaps = (s, n) => { if (n < 2) return s; let i = 0; return s.replace(/_____/g, () => `(${++i}) ${GAP}`); };
const fillGaps = (s, answers) => { let i = 0; return s.replace(/_____/g, () => answers[i++] ?? '...'); };

/** Alternativen einer Lösung: "désolé/e" ergibt désolé und désolée */
function altList(a) {
    const s = String(a).trim();
    if (!s.includes('/')) return [s];
    const parts = s.split('/').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2 && parts[1].length <= 3) return [parts[0], parts[0] + parts[1]];
    return parts;
}

/* ---- Lücken-Lösungen mit dem Wörterbuch vorschlagen (Französisch) ---- */
/** Gebeugte Formen des Stichworts (Verb, Nomen, Adjektiv); nur echte Wörterbuchwörter bleiben übrig */
function frForms(core) {
    const forms = new Set([core]);
    const add = (stem, ends) => ends.forEach((e) => forms.add(stem + e));
    if (/er$/.test(core) && core.length > 3) {
        const s = core.slice(0, -2);
        add(s, ['e', 'es', 'ent', 'ons', 'ez', 'é', 'ée', 'és', 'ées', 'ais', 'ait', 'aient', 'ions', 'iez', 'erai', 'eras', 'era', 'erons', 'erez', 'eront', 'erais', 'erait', 'eraient', 'ant', 'a', 'ai', 'èrent']);
        if (/g$/.test(s)) add(s, ['eons', 'eant', 'eais', 'eait', 'eaient']);
        if (/c$/.test(s)) add(s.slice(0, -1) + 'ç', ['ons', 'ais', 'ait', 'aient', 'ant']);
    } else if (/ir$/.test(core) && core.length > 3) {
        const s = core.slice(0, -2);
        add(s, ['is', 'it', 'issons', 'issez', 'issent', 'i', 'ie', 'ies', 'issais', 'issait', 'issaient', 'irai', 'iras', 'ira', 'irons', 'irez', 'iront', 'ît']);
    } else if (/re$/.test(core) && core.length > 4) {
        const s = core.slice(0, -2);
        add(s, ['', 's', 't', 'ons', 'ez', 'ent', 'u', 'ue', 'us', 'ues', 'ais', 'ait', 'aient', 'rai', 'ras', 'ra', 'rons', 'rez', 'ront']);
        if (/nd$/.test(s)) add(s.slice(0, -1), ['s', 't', 'gnons', 'gnez', 'gnent', 'gnais', 'gnait', 'gnant']);   // rejoindre: rejoins, rejoint, rejoignent
    } else {
        add(core, ['s', 'x', 'e', 'es']);
        if (/al$/.test(core)) forms.add(core.slice(0, -2) + 'aux');
    }
    return [...forms];
}
const PRON = [
    [/^(je|j')$/, ['e', 'ai', 'ais', 'is', 's', 'x']],
    [/^tu$/, ['es', 'as', 'ais', 'is', 's']],
    [/^(il|elle|on|qui|ce|c'|qu')$/, ['e', 'a', 'ait', 'it', 't', 'd']],
    [/^nous$/, ['ons', 'ions']],
    [/^vous$/, ['ez', 'iez']],
    [/^(ils|elles)$/, ['ent', 'aient', 'ont']]
];
const AUX_FR = new Set(['ai', 'as', 'a', 'avons', 'avez', 'ont', 'est', 'suis', 'es', 'sommes', 'êtes', 'sont', 'avais', 'avait', 'étais', 'était', 'aurai', 'sera']);
const INF_BEFORE = new Set(['pour', 'de', "d'", 'à', 'sans', 'dois', 'doit', 'peux', 'peut', 'veux', 'veut', 'vais', 'va', 'faut', 'aller', 'pouvoir', 'vouloir', 'devoir', 'savoir', 'sais', 'sait', 'aime', 'aimes']);
const DET_PL = new Set(['les', 'des', 'mes', 'tes', 'ses', 'nos', 'vos', 'leurs', 'ces', 'plusieurs', 'quelques']);
const DET_SG = new Set(['le', 'la', "l'", 'un', 'une', 'mon', 'ma', 'ton', 'ta', 'son', 'sa', 'ce', 'cet', 'cette', 'notre', 'votre', 'leur', 'du', 'au']);
/** Wort direkt vor der n-ten Lücke (kleingeschrieben) */
function gapPrevWord(sentence, idx) {
    let pos = -1;
    for (let i = 0; i <= idx; i++) {
        pos = sentence.indexOf(GAP, pos + 1);
        if (pos < 0) return '';
    }
    const m = sentence.slice(0, pos).match(/([\p{L}’']+)[\s’']*$/u);
    return m ? m[1].toLowerCase().replace(/’/g, "'") : '';
}
/** Formen nach der Grammatik der Umgebung ordnen (Personalpronomen, Hilfsverb, Artikel, Infinitiv) */
function rankForms(forms, core, prev) {
    const pr = PRON.find(([re]) => re.test(prev));
    const scored = forms.map((f, i) => {
        let s = 0;
        if (INF_BEFORE.has(prev)) s = f === core ? 3 : 0;
        else if (AUX_FR.has(prev)) {
            // Partizip: bei -er-Verben é/ée/és/ées, sonst i/u/t-Formen (Vermeidet "souhaite" als Partizip von souhaiter)
            const part = /er$/.test(core) ? /(é|ée|és|ées)$/ : /(i|ie|is|ies|u|ue|us|ues|t|te|ts|tes)$/;
            s = f !== core && part.test(f) ? 3 : 0;
        }
        else if (DET_PL.has(prev)) s = f !== core && /[sx]$/.test(f) ? 3 : 0;
        else if (DET_SG.has(prev)) s = f === core ? 3 : (/e$/.test(f) ? 1 : 0);
        else if (pr) s = f !== core && pr[1].some((e) => f.endsWith(e)) ? 2 : 0;
        return { f, s, i };
    });
    return scored.sort((a, b) => b.s - a.s || a.i - b.i);
}
function suggestGap(item, idx) {
    if (item.lang !== 'fr' || !dicts.fr) return null;
    const core = coreWord(item.term);
    if (core.length < 3) return null;
    const forms = frForms(core).filter((f) => dicts.fr.has(f));
    if (!forms.length) return null;
    const ranked = rankForms(forms, core, gapPrevWord(item.sentence, idx));
    return { a: ranked[0].f, alts: forms.slice(0, 12) };
}
const AUTO_MSG = 'Lücken-Lösung automatisch vorgeschlagen, bitte prüfen';
/** Fehlende Lücken-Lösungen mit Formen des Stichworts füllen; als "Bitte prüfen" markiert, alle passenden Formen werden akzeptiert */
function fillGapSuggestions(lang) {
    if (lang !== 'fr' || !dicts.fr) return 0;
    let n = 0;
    vocabularyPool.forEach((v) => {
        if (v.lang !== 'fr' || countGaps(v.sentence) !== v.gaps.length) return;
        let any = false;
        v.gaps.forEach((g, i) => {
            if (g.a) return;
            const s = suggestGap(v, i);
            if (!s) return;
            g.a = s.a;
            g.alts = s.alts;
            g.auto = true;
            any = true;
            n++;
        });
        if (any) v.warn = [...(v.warn || []).filter((x) => x !== AUTO_MSG), AUTO_MSG];
    });
    if (n) savePool();
    return n;
}

function gapInfo(item) {
    const cnt = countGaps(item.sentence);
    if (cnt && item.gaps.length === cnt && item.gaps.every((g) => g.a)) {
        return {
            text: numberGaps(item.sentence, cnt),
            answers: item.gaps.map((g) => g.a),
            alts: item.gaps.map((g) => g.alts || []),
            blanks: cnt,
            auto: item.gaps.some((g) => g.auto)
        };
    }
    if (!cnt) {
        const g = makeGap(item);
        if (g) return { text: g.text, answers: [g.match], alts: [[]], blanks: 1, auto: false };
    }
    return null;
}
/** Satz zur Anzeige: Lücken mit den Lösungen gefüllt, falls bekannt */
function displaySentence(item) {
    const cnt = countGaps(item.sentence);
    if (cnt && item.gaps.length === cnt && item.gaps.every((g) => g.a)) {
        return fillGaps(item.sentence, item.gaps.map((g) => altList(g.a)[0]));
    }
    return item.sentence;
}

/** Alle akzeptierten Schreibweisen eines Stichworts */
function alts(item) {
    const raw = String(item.term);
    const set = new Set();
    const add = (s) => {
        for (const v of [s.replace(/\([^)]*\)?/g, ' '), s.replace(/[()]/g, ' ')]) {
            const n = normAns(v);
            if (!n) continue;
            set.add(n);
            if (item.lang === 'fr') { const b = stripArticle(n); if (b) set.add(b); }
        }
    };
    add(raw);
    if (raw.includes('/')) raw.split('/').forEach(add);
    if (item.lang === 'en') { const c = coreWord(raw); if (c) set.add(c); }
    return [...set];
}

function matchTargets(input, targets) {
    const a = normAns(input);
    if (!a) return null;
    if (targets.includes(a)) return 'exact';
    if (targets.some((t) => strip(t) === strip(a))) return 'accent';
    if (targets.some((t) => t.length >= 5 && levenshtein(strip(t), strip(a)) <= 1)) return 'typo';
    return null;
}
const judgeTerm = (answer, item) => matchTargets(answer, alts(item));

function judgeGap(input, info) {
    const parts = info.blanks > 1 ? input.split(/[;,]/) : [input];
    if (parts.length < info.blanks) return null;
    let worst = 'exact';
    for (let i = 0; i < info.blanks; i++) {
        const targets = [...altList(info.answers[i]), ...((info.alts && info.alts[i]) || [])].map(normAns);
        const r = matchTargets(parts[i] || '', targets);
        if (!r) return null;
        if (r === 'typo') worst = 'typo';
        else if (r === 'accent' && worst === 'exact') worst = 'accent';
    }
    return worst;
}

const cleanDe = (s) => s.toLowerCase().replace(/[.,;:!?"“”„()]/g, ' ').replace(/\s+/g, ' ').trim();
function judgeDe(answer, item) {
    const a = cleanDe(answer);
    if (!a) return null;
    const parts = item.de.replace(/\([^)]*\)?/g, ' ').split(/[;,]/).map(cleanDe).filter(Boolean);
    const targets = new Set();
    parts.forEach((p) => {
        targets.add(p);
        targets.add(p.replace(/^(der|die|das|ein|eine|einen|sich|jmdn|jdn|etw|jmd|jmdm)\s+/, ''));
    });
    if (targets.has(a)) return 'exact';
    if ([...targets].some((t) => t.length >= 5 && levenshtein(t, a) <= 1)) return 'typo';
    return null;
}

/* ================= Phasen-System ================= */
const isNew = (v) => v.ok + v.bad === 0;

/** Tägliche Übung wie bei Phase 6: alle neuen Vokabeln plus alle, deren Intervall abgelaufen ist */
function dueList(pool) {
    const now = Date.now();
    const review = pool.filter((v) => !isNew(v) && v.due <= now).sort((a, b) => a.due - b.due || a.phase - b.phase);
    const fresh = pool.filter(isNew);
    return { review, fresh };
}
const troubleList = (pool) => pool
    .filter((v) => v.bad >= 2 && v.streak < 3)
    .sort((a, b) => b.bad - a.bad || a.streak - b.streak);

function nextDueText(pool) {
    const now = Date.now();
    const future = pool.filter((v) => !isNew(v) && v.due > now).map((v) => v.due);
    if (!future.length) return 'keine geplant';
    const rel = relDay(Math.min(...future));
    const n = future.filter((t) => relDay(t) === rel).length;
    return `${rel} (${n} Vokabeln)`;
}

function schedule(item, correct) {
    if (correct) {
        if (item.phase < 6) { item.phase++; promoted++; }
        item.due = dueTs(settings.intervals[item.phase - 1]);
    } else {
        const np = settings.onWrong === 'back' ? Math.max(1, item.phase - 1) : 1;
        if (np < item.phase) demoted++;
        item.phase = np;
        item.due = Date.now();
    }
}

/** Antwort verbuchen: Zähler, Serie, Tagesstatistik, bei der täglichen Übung auch die Phase */
function recordAnswer(item, correct) {
    const first = !sessionDone.has(item);
    const exam = sessionKind === 'exam' ? sessionExam : null;
    const global = !exam || exam.affect;                 // Prüfungsübung ändert die Phasen nur, wenn das gewählt wurde
    const wasNew = isNew(item);
    if (global) { if (correct) { item.ok++; item.streak++; } else { item.bad++; item.streak = 0; } }
    if (!first) return;                                  // Wiederholungen derselben Vokabel ändern Phase und Statistik nicht
    sessionDone.add(item);
    answeredCount++;
    if (!correct) mistakeCount++;
    const t = touchToday();
    t.n++;
    if (correct) t.ok++;
    if (wasNew && global) t.nw++;
    if (exam) examSchedule(exam, item, correct);
    if (global && (sessionKind === 'daily' || exam)) schedule(item, correct);
}

/** Frageart pro Vokabel. Standard: Deutsch zeigen, Fremdsprache eingeben */
function questionMode(item) {
    if (sessionKind === 'free') return mode;                 // freie Übung läuft in Runden
    const hasGap = !!gapInfo(item);
    if (qChoice === 'translate') return 'translate';
    if (qChoice === 'reverse') return 'reverse';
    if (qChoice === 'gap') return hasGap ? 'gap' : 'translate';
    // gemischt
    if (sessionKind === 'trouble' || sessionKind === 'exam') {
        const opts = ['translate', 'reverse'];
        if (hasGap) opts.push('gap');
        return opts[Math.floor(Math.random() * opts.length)];
    }
    if (item.phase <= 2) return 'reverse';                   // tägliche Übung: leicht nach schwer
    if (item.phase <= 4) return 'translate';
    return hasGap ? 'gap' : 'translate';
}

/* ================= Üben-Ansicht ================= */
function updateModeLabels() {
    const n = LANGS[currentLang].name;
    const set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
    set('mo-translate', `Deutsch zeigen, ${n} eingeben (Standard)`);
    set('mo-reverse', `${n} zeigen, Deutsch eingeben`);
    set('mo-gap', 'Lückentext (Satz ergänzen)');
    set('mo-mixed', 'Gemischt (tägliche Übung: leicht nach schwer je Phase)');
}
function selectedItems() {
    return langPool().filter((v) => !deselected.has(groupKey(v)));
}

function renderPhaseBars(pool) {
    const box = $('phase-bars');
    box.replaceChildren();
    const c = [0, 0, 0, 0, 0, 0];
    pool.forEach((v) => { c[v.phase - 1]++; });
    const max = Math.max(1, ...c);
    c.forEach((n, i) => {
        const row = document.createElement('div');
        row.className = 'phase-row';
        const label = document.createElement('span');
        label.textContent = i === 5 ? 'Phase 6 (gelernt)' : `Phase ${i + 1}`;
        const bar = document.createElement('span');
        bar.className = 'phase-bar';
        const fill = document.createElement('span');
        fill.style.width = `${(n / max) * 100}%`;
        bar.append(fill);
        const cnt = document.createElement('span');
        cnt.className = 'phase-count';
        cnt.textContent = String(n);
        row.append(label, bar, cnt);
        box.append(row);
    });
}

function renderToday() {
    const pool = selectedItems();
    const { review, fresh } = dueList(pool);
    const total = review.length + fresh.length;
    const t = todayStats();

    $('today-summary').textContent = total
        ? `${total} Vokabeln warten: ${review.length} Wiederholungen und ${fresh.length} neue.`
        : `Heute ist nichts mehr fällig. Nächste Wiederholung: ${nextDueText(pool)}.`;
    const bar = $('goal-bar');
    bar.max = settings.dailyGoal;
    bar.value = Math.min(t.n, settings.dailyGoal);
    $('goal-text').textContent = `${t.n} von ${settings.dailyGoal} Abfragen heute${t.n ? `, davon ${t.ok} richtig` : ''}`;
    const s = streakDays();
    $('streak-text').textContent = `Serie: ${s} ${s === 1 ? 'Tag' : 'Tage'} in Folge`;
    $('daily-btn').disabled = total === 0;

    const trouble = troubleList(pool);
    const tb = $('trouble-btn');
    tb.textContent = trouble.length ? `Problem-Vokabeln (${trouble.length})` : 'Problem-Vokabeln';
    tb.disabled = trouble.length === 0;
}

function updateSelCount() {
    const sel = selectedItems();
    const gapN = sel.filter((v) => gapInfo(v)).length;
    $('sel-count').textContent = `${sel.length} von ${langPool().length} ausgewählt, ${gapN} mit Lückentext`;
    renderToday();
}
function renderLearn() {
    const pool = langPool();
    $('learn-empty').hidden = pool.length > 0;
    $('learn-body').hidden = pool.length === 0;
    updateModeLabels();
    const groups = new Map();
    pool.forEach((v) => { const k = groupKey(v); groups.set(k, (groups.get(k) || 0) + 1); });
    const box = $('group-list');
    box.replaceChildren();
    [...groups.keys()].forEach((k) => {      // Reihenfolge wie im Buch (so, wie die Bereiche importiert wurden)
        const label = document.createElement('label');
        label.className = 'check-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !deselected.has(k);
        cb.addEventListener('change', () => {
            if (cb.checked) deselected.delete(k); else deselected.add(k);
            updateSelCount();
        });
        const txt = document.createElement('span');
        txt.textContent = `${k} (${groups.get(k)})`;
        label.append(cb, txt);
        box.append(label);
    });
    renderPhaseBars(pool);
    renderExams();
    updateSelCount();
}

/* Einstellungen */
function syncSettingsUI() {
    settings.intervals.forEach((n, i) => setVal(`iv-${i + 1}`, n));
    setVal('set-wrong', settings.onWrong);
    setVal('set-goal', settings.dailyGoal);
    setVal('set-time', settings.reminderTime);
    refreshPushUI();
}
function readSettingsUI() {
    const get = (id, fallback) => { const el = $(id); return el ? el.value : fallback; };
    settings = sanitizeSettings({
        intervals: [1, 2, 3, 4, 5, 6].map((i) => get(`iv-${i}`, settings.intervals[i - 1])),
        onWrong: get('set-wrong', settings.onWrong),
        dailyGoal: get('set-goal', settings.dailyGoal),
        reminderTime: get('set-time', settings.reminderTime)
    });
    savePool();
    renderToday();
    refreshPushUI();
    ensurePushRow();
}

/* ================= Listen-Ansicht ================= */
function updatePathSuggest() {
    for (let i = 0; i < 3; i++) {
        const set = new Set();
        langPool().forEach((v) => { if (v.path[i]) set.add(v.path[i]); });
        const dl = $(`dl-${i + 1}`);
        dl.replaceChildren();
        [...set].sort(naturalCompare).forEach((p) => {
            const o = document.createElement('option');
            o.value = p;
            dl.append(o);
        });
    }
}

function buildTree(items) {
    const root = { name: '', children: new Map(), items: [] };
    items.forEach((v) => {
        let node = root;
        v.path.forEach((seg) => {
            if (!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), items: [] });
            node = node.children.get(seg);
        });
        node.items.push(v);
    });
    return root;
}
const countItems = (n) => n.items.length + [...n.children.values()].reduce((s, c) => s + countItems(c), 0);
const matchesPrefix = (v, prefix) => prefix.every((p, i) => v.path[i] === p);

function iconButton(text, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
}

function renameSection(prefix) {
    const old = prefix[prefix.length - 1];
    const input = prompt(`Neuer Name für „${old}“:`, old);
    if (input === null) return;
    const name = input.trim();
    if (!name || name === old) return;
    langPool().forEach((v) => { if (matchesPrefix(v, prefix)) v.path[prefix.length - 1] = name; });
    savePool();
    refreshAll();
}
function deleteSection(prefix) {
    const hit = langPool().filter((v) => matchesPrefix(v, prefix));
    if (!hit.length) return;
    if (!confirm(`„${prefix.join(' › ')}“ mit ${hit.length} Vokabeln löschen?`)) return;
    vocabularyPool = vocabularyPool.filter((v) => !hit.includes(v));
    rebuildProtected();
    savePool();
    refreshAll();
}

/** Text schreiben und unsicher gelesene Wörter hervorheben */
function appendMarked(el, text, marks) {
    if (!marks || !marks.length) { el.append(document.createTextNode(text)); return; }
    const set = new Set(marks);
    const re = /\p{L}+/gu;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
        if (!set.has(m[0].toLowerCase())) continue;
        if (m.index > last) el.append(document.createTextNode(text.slice(last, m.index)));
        const mk = document.createElement('mark');
        mk.className = 'lowconf';
        mk.title = 'Unsicher gelesen';
        mk.textContent = m[0];
        el.append(mk);
        last = m.index + m[0].length;
    }
    if (last < text.length) el.append(document.createTextNode(text.slice(last)));
}

/* ---- Auswahlmodus ---- */
function updateSelectBar() {
    const bar = $('select-bar');
    if (!bar) return;
    bar.hidden = !selectMode;
    $('select-count').textContent = `${selectedIds.size} ausgewählt`;
    ['sel-move', 'sel-exam', 'sel-delete'].forEach((id) => { $(id).disabled = selectedIds.size === 0; });
    $('select-btn').textContent = selectMode ? 'Auswahl beenden' : 'Auswählen';
}
function setSelectMode(on) {
    selectMode = on;
    if (!on) selectedIds.clear();
    renderLists();
}
function collectNodeItems(node) {
    return [...node.items, ...[...node.children.values()].flatMap(collectNodeItems)];
}
function toggleSelectNode(node) {
    const items = collectNodeItems(node);
    const all = items.every((v) => selectedIds.has(v.id));
    items.forEach((v) => { if (all) selectedIds.delete(v.id); else selectedIds.add(v.id); });
    renderLists();
}
function deleteSelected() {
    const n = selectedIds.size;
    if (!n || !confirm(`${n} Vokabeln löschen?`)) return;
    vocabularyPool = vocabularyPool.filter((v) => !selectedIds.has(v.id));
    rebuildProtected();
    savePool();
    selectMode = false;
    selectedIds.clear();
    refreshAll();
}

/* ---- Kategorien verschieben, Vokabeln in Kategorien eintragen ---- */
function moveSection(prefix, parent) {
    if (parent.length >= prefix.length && prefix.every((p, i) => parent[i] === p)) return 'Eine Kategorie kann nicht in sich selbst verschoben werden.';
    const hits = langPool().filter((v) => matchesPrefix(v, prefix));
    if (!hits.length) return 'In dieser Kategorie sind keine Vokabeln.';
    const newPaths = hits.map((v) => [...parent, ...v.path.slice(prefix.length - 1)]);
    if (newPaths.some((p) => p.length > 3)) return 'Zu tief verschachtelt: Es sind höchstens 3 Ebenen möglich.';
    hits.forEach((v, i) => { v.path = newPaths[i]; });
    return '';
}
function openMoveDialog(kind, info = {}) {
    moveCtx = { kind, ...info };
    const sel = $('mv-existing');
    sel.replaceChildren();
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Bestehende Kategorie wählen...';
    sel.append(first);
    const seen = new Set();
    langPool().forEach((v) => v.path.forEach((_, i) => {
        const p = v.path.slice(0, i + 1);
        const k = p.join(' › ');
        if (seen.has(k)) return;
        seen.add(k);
        const o = document.createElement('option');
        o.value = JSON.stringify(p);
        o.textContent = k;
        sel.append(o);
    }));
    [1, 2, 3].forEach((i) => setVal(`mv-${i}`, ''));
    $('mv-msg').hidden = true;
    if (kind === 'section') {
        const name = info.prefix[info.prefix.length - 1];
        $('mv-title').textContent = `Kategorie „${name}“ verschieben`;
        $('mv-info').dataset.info = `Wähle die übergeordnete Kategorie, unter der „${name}“ künftig stehen soll. Leer lassen = oberste Ebene. Gibt es dort schon eine Kategorie mit demselben Namen, werden beide zusammengeführt.`;
    } else {
        $('mv-title').textContent = `${selectedIds.size} Vokabeln verschieben`;
        $('mv-info').dataset.info = 'Wähle eine bestehende Kategorie oder tippe einen neuen Namen ein. Bis zu 3 Ebenen sind möglich (z. B. Unité 1, Volet 2, Module A).';
    }
    $('move-dialog').showModal();
}
function confirmMove() {
    if (!moveCtx) return;
    const path = [1, 2, 3].map((i) => $(`mv-${i}`).value.trim()).filter(Boolean);
    const msg = (t) => { const el = $('mv-msg'); el.textContent = t; el.hidden = !t; };
    if (moveCtx.kind === 'items') {
        vocabularyPool.forEach((v) => { if (selectedIds.has(v.id)) v.path = [...path]; });
    } else {
        const err = moveSection(moveCtx.prefix, path);
        if (err) return msg(err);
    }
    moveCtx = null;
    $('move-dialog').close();
    rebuildProtected();
    savePool();
    selectMode = false;
    selectedIds.clear();
    refreshAll();
}
function addToSection(prefix) {
    showTab('add');
    [0, 1, 2].forEach((i) => setVal(`path-${i + 1}`, prefix[i] || ''));
    const d = $('manual-box');
    if (d) d.open = true;
    $('m-term').focus();
    setStatus(`Neue Vokabeln werden in „${prefix.join(' › ')}“ eingetragen. Für Screenshots die automatische Erkennung der Bereiche abschalten, wenn alles in diese Kategorie soll.`, 'ok');
}

/* ---- Vokabeln zu einer Prüfung hinzufügen ---- */
function openPickExam() {
    if (!selectedIds.size) return;
    const open = exams.filter((e) => examDays(e) >= 0);
    if (!open.length) { setStatus('Lege zuerst im Tab „Üben“ eine Prüfung an.', 'error'); return; }
    const sel = $('pick-exam');
    sel.replaceChildren();
    open.forEach((e) => {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = `${e.name} (${fmtDate(e.date)})`;
        sel.append(o);
    });
    $('pick-dialog').showModal();
}
function confirmPick() {
    const ex = exams.find((e) => e.id === $('pick-exam').value);
    const n = selectedIds.size;
    if (ex) {
        const set = new Set(ex.ids);
        selectedIds.forEach((id) => set.add(id));
        ex.ids = [...set];
        savePool();
        setStatus(`${n} Vokabeln zur Prüfung „${ex.name}“ hinzugefügt.`, 'ok');
    }
    $('pick-dialog').close();
    setSelectMode(false);
    renderExams();
}

function itemMeta(v) {
    const parts = [`Phase ${v.phase}`];
    if (isNew(v)) parts.push('neu');
    else parts.push(v.due <= Date.now() ? 'fällig' : `fällig ${relDay(v.due)}`);
    if (v.bad) parts.push(`${v.bad} Fehler`);
    if (v.bad >= 2 && v.streak < 3) parts.push('Problem-Vokabel');
    return parts.join(' · ');
}

function updateWarnCount() {
    const n = langPool().filter((v) => v.warn && v.warn.length).length;
    const el = $('warn-count');
    if (el) el.textContent = n ? `(${n})` : '';
}

function buildItemRow(v) {
    const row = document.createElement('div');
    row.className = 'item';
    if (selectMode) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'row-check';
        cb.checked = selectedIds.has(v.id);
        cb.setAttribute('aria-label', `${v.term} auswählen`);
        cb.addEventListener('change', () => {
            if (cb.checked) selectedIds.add(v.id); else selectedIds.delete(v.id);
            updateSelectBar();
        });
        row.append(cb);
    }
    const main = document.createElement('div');
    main.className = 'item-main';
    const t = document.createElement('strong');
    appendMarked(t, v.term, v.lowc && v.lowc.term);
    const d = document.createElement('span');
    d.append(document.createTextNode(' – '));
    appendMarked(d, v.de, v.lowc && v.lowc.de);
    main.append(t, d);
    if (v.sentence) {
        const s = document.createElement('div');
        s.className = 'item-sent';
        appendMarked(s, displaySentence(v), v.lowc && v.lowc.sentence);
        main.append(s);
    }
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = itemMeta(v);
    main.append(meta);
    if (v.warn && v.warn.length) {
        const w = document.createElement('div');
        w.className = 'warn-note';
        w.textContent = `Bitte prüfen: ${v.warn.join(' · ')}`;
        main.append(w);
    }
    if (v.fix && v.fix.length) {
        const note = document.createElement('div');
        note.className = 'fix-note';
        note.textContent = `Automatisch korrigiert: ${v.fix.join(' · ')}`;
        main.append(note);
    }
    const acts = document.createElement('div');
    acts.className = 'item-actions';
    if (v.warn && v.warn.length) {
        acts.append(iconButton('Geprüft', `${v.term} als geprüft markieren`, () => {
            v.warn = undefined;
            v.lowc = undefined;
            savePool();
            if (onlyWarn) row.remove(); else row.replaceWith(buildItemRow(v));
            updateWarnCount();
        }));
    }
    acts.append(
        iconButton('Bearbeiten', `${v.term} bearbeiten`, () => row.replaceWith(buildEditor(v))),
        iconButton('Löschen', `${v.term} löschen`, () => {
            vocabularyPool = vocabularyPool.filter((x) => x !== v);
            rebuildProtected();
            savePool();
            refreshAll();
        })
    );
    row.append(main, acts);
    return row;
}

function buildEditor(v) {
    const form = document.createElement('div');
    form.className = 'editor';
    if (v.lowc) {
        const words = [...new Set([...(v.lowc.term || []), ...(v.lowc.de || []), ...(v.lowc.sentence || [])])];
        if (words.length) {
            const n = document.createElement('div');
            n.className = 'warn-note';
            n.textContent = `Unsicher gelesen: ${words.join(', ')}`;
            form.append(n);
        }
    }
    const mk = (label, value, list) => {
        const wrap = document.createElement('label');
        wrap.className = 'field';
        const sp = document.createElement('span');
        sp.textContent = label;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = value;
        inp.autocomplete = 'off';
        if (list) inp.setAttribute('list', list);
        wrap.append(sp, inp);
        form.append(wrap);
        return inp;
    };
    const mkSelect = (label, entries, value) => {
        const wrap = document.createElement('label');
        wrap.className = 'field';
        const sp = document.createElement('span');
        sp.textContent = label;
        const sel = document.createElement('select');
        entries.forEach(([val, text]) => {
            const o = document.createElement('option');
            o.value = val;
            o.textContent = text;
            sel.append(o);
        });
        sel.value = value;
        wrap.append(sp, sel);
        form.append(wrap);
        return sel;
    };

    const langSel = mkSelect('Sprache', Object.entries(LANGS).map(([k, val]) => [k, val.name]), v.lang);
    const iTerm = mk(`${LANGS[v.lang].name} (Stichwort)`, v.term);
    const iDe = mk('Deutsch', v.de);
    const iSent = mk('Beispielsatz (Lücke = _____)', v.sentence);
    const iGaps = mk('Lücken-Lösung(en), mit ; trennen', v.gaps.map((g) => g.a).join('; '));
    const p1 = mk('Kategorie, Ebene 1', v.path[0] || '', 'dl-1');
    const p2 = mk('Kategorie, Ebene 2', v.path[1] || '', 'dl-2');
    const p3 = mk('Kategorie, Ebene 3', v.path[2] || '', 'dl-3');
    const phSel = mkSelect('Phase', [1, 2, 3, 4, 5, 6].map((n) => [String(n), `Phase ${n}`]), String(v.phase));

    const actions = document.createElement('div');
    actions.className = 'actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'nav-btn';
    save.textContent = 'Speichern';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Abbrechen';
    actions.append(save, cancel);
    form.append(actions);

    cancel.addEventListener('click', () => form.replaceWith(buildItemRow(v)));
    save.addEventListener('click', () => {
        const term = iTerm.value.trim();
        const de = iDe.value.trim();
        if (!term || !de) { iTerm.focus(); return; }
        const oldKey = `${v.lang}|${v.path.join('>')}`;
        v.lang = langSel.value;
        v.term = term;
        v.de = de;
        v.sentence = normGapMarks(iSent.value.trim());
        const cnt = countGaps(v.sentence);
        const ans = iGaps.value.split(';').map((s) => s.trim());
        v.gaps = Array.from({ length: cnt }, (_, i) => ({ n: v.gaps[i] ? v.gaps[i].n : null, a: ans[i] || '', auto: false, alts: [] }));
        v.path = [p1.value, p2.value, p3.value].map((s) => s.trim()).filter(Boolean);
        const np = Number(phSel.value);
        if (np !== v.phase) {
            v.phase = np;
            v.due = np === 1 ? 0 : dueTs(settings.intervals[np - 1]);
        }
        v.fix = undefined;                                   // von Hand bestätigt
        v.warn = undefined;
        v.lowc = undefined;
        addConfirmed(`${term} ${de} ${v.sentence}`);
        rebuildProtected();
        savePool();
        if (oldKey !== `${v.lang}|${v.path.join('>')}`) refreshAll();
        else { form.replaceWith(buildItemRow(v)); updatePathSuggest(); updateWarnCount(); }
    });
    return form;
}

function renderNode(node, prefix, openAll) {
    const frag = document.createDocumentFragment();

    const makeSection = (title, key, count, fillFn, actions) => {
        const det = document.createElement('details');
        det.className = 'sec';
        const sum = document.createElement('summary');
        const label = document.createElement('span');
        label.className = 'sec-title';
        label.textContent = `${title} (${count})`;
        sum.append(label);
        if (actions) sum.append(actions);
        const body = document.createElement('div');
        body.className = 'sec-body';
        det.append(sum, body);
        let filled = false;
        const fill = () => { if (!filled) { filled = true; fillFn(body); } };   // Inhalt erst beim Öffnen aufbauen
        det.open = openAll || openSections.has(key);
        if (det.open) fill();
        det.addEventListener('toggle', () => {
            if (det.open) { fill(); if (!openAll) openSections.add(key); }
            else if (!openAll) openSections.delete(key);
        });
        return det;
    };

    if (prefix.length) node.items.forEach((v) => frag.append(buildItemRow(v)));

    [...node.children.values()].forEach((child) => {      // Reihenfolge wie importiert (= wie im Buch)
        const path = [...prefix, child.name];
        const acts = document.createElement('span');
        acts.className = 'sec-actions';
        if (selectMode) acts.append(iconButton('Alle wählen', `Alle Vokabeln in „${child.name}“ wählen`, () => toggleSelectNode(child)));
        acts.append(
            iconButton('Umbenennen', `„${child.name}“ umbenennen`, () => renameSection(path)),
            iconButton('Verschieben', `„${child.name}“ verschieben`, () => openMoveDialog('section', { prefix: path })),
            iconButton('+ Vokabel', `Vokabel in „${child.name}“ hinzufügen`, () => addToSection(path)),
            iconButton('Löschen', `„${child.name}“ löschen`, () => deleteSection(path))
        );
        frag.append(makeSection(child.name, path.join(' › '), countItems(child), (body) => body.append(renderNode(child, path, openAll)), acts));
    });

    if (!prefix.length && node.items.length) {
        frag.append(makeSection('Ohne Bereich', '__none__', node.items.length, (body) => node.items.forEach((v) => body.append(buildItemRow(v))), null));
    }
    return frag;
}

function renderLists() {
    const q = listQuery.trim().toLowerCase();
    const all = langPool();
    const items = all.filter((v) => (!q || `${v.term} ${v.de} ${v.sentence}`.toLowerCase().includes(q)) && (!onlyWarn || (v.warn && v.warn.length)));
    const tree = $('list-tree');
    tree.replaceChildren();
    const empty = $('list-empty');
    empty.hidden = items.length > 0;
    empty.textContent = all.length ? 'Keine Treffer.' : `Noch keine ${LANGS[currentLang].adj} Vokabeln. Füge sie im Tab „Hinzufügen“ hinzu.`;
    tree.append(renderNode(buildTree(items), [], !!q || onlyWarn));
    updateAddLabels();
    updateWarnCount();
    updateSelectBar();
}

/* ================= Prüfungen: Anzeige ================= */
function renderExams() {
    const box = $('exam-list');
    if (!box) return;
    box.replaceChildren();
    const list = [...exams].sort((a, b) => a.date.localeCompare(b.date));
    $('exam-empty').hidden = list.length > 0;
    list.forEach((ex) => {
        const days = examDays(ex);
        const items = examItems(ex);
        const due = days >= 0 ? examDueItems(ex).length : 0;
        const when = days < 0 ? 'vorbei' : days === 0 ? 'heute' : days === 1 ? 'morgen' : `in ${days} Tagen`;
        const row = document.createElement('div');
        row.className = 'exam-row';
        const info = document.createElement('div');
        info.className = 'exam-info';
        const name = document.createElement('strong');
        name.textContent = ex.name;
        const sub = document.createElement('div');
        sub.className = 'item-meta';
        sub.textContent = `${fmtDate(ex.date)} (${when}) · ${items.length} Vokabeln${days >= 0 ? ` · heute fällig: ${due}` : ''}`;
        info.append(name, sub);
        const acts = document.createElement('div');
        acts.className = 'item-actions';
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'mini nav-btn';
        go.textContent = 'Üben';
        go.disabled = due === 0 || days < 0;
        go.addEventListener('click', () => requestSession('exam', ex.id));
        acts.append(
            go,
            iconButton('Bearbeiten', `${ex.name} bearbeiten`, () => openExamDialog(ex.id)),
            iconButton('Löschen', `${ex.name} löschen`, () => {
                if (!confirm(`Prüfung „${ex.name}“ löschen? Die Vokabeln selbst bleiben erhalten.`)) return;
                exams = exams.filter((x) => x.id !== ex.id);
                savePool();
                renderExams();
            })
        );
        row.append(info, acts);
        box.append(row);
    });
}

function openExamDialog(id) {
    editingExamId = id || null;
    const ex = id ? exams.find((e) => e.id === id) : null;
    $('exam-title').textContent = ex ? 'Prüfung bearbeiten' : 'Neue Prüfung';
    setVal('ex-name', ex ? ex.name : '');
    const d = new Date();
    d.setDate(d.getDate() + 7);
    setVal('ex-date', ex ? ex.date : dateKey(d));
    $('ex-affect').checked = ex ? ex.affect : false;
    $('ex-msg').hidden = true;
    const have = new Set(ex ? ex.ids : []);
    const groups = new Map();
    vocabularyPool.forEach((v) => {
        const k = `${v.lang}|${groupKey(v)}`;
        if (!groups.has(k)) groups.set(k, { label: `${LANGS[v.lang].name}: ${groupKey(v)}`, ids: [] });
        groups.get(k).ids.push(v.id);
    });
    const box = $('ex-cats');
    box.replaceChildren();
    exCatState = [];
    groups.forEach((g) => {
        const label = document.createElement('label');
        label.className = 'check-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        const was = g.ids.every((i) => have.has(i));
        cb.checked = was;
        const txt = document.createElement('span');
        txt.textContent = `${g.label} (${g.ids.length})`;
        label.append(cb, txt);
        box.append(label);
        exCatState.push({ ids: g.ids, cb, was });
    });
    $('exam-dialog').showModal();
}
function saveExam() {
    const name = $('ex-name').value.trim();
    const date = $('ex-date').value;
    const msg = (t) => { const el = $('ex-msg'); el.textContent = t; el.hidden = !t; };
    if (!name) return msg('Bitte einen Namen eingeben.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return msg('Bitte ein Datum wählen.');
    if (examDays({ date }) < 0) return msg('Das Datum liegt in der Vergangenheit.');
    const old = editingExamId ? exams.find((e) => e.id === editingExamId) : null;
    const ids = new Set(old ? old.ids : []);
    exCatState.forEach(({ ids: gids, cb, was }) => {
        if (cb.checked) gids.forEach((i) => ids.add(i));
        else if (was) gids.forEach((i) => ids.delete(i));
    });
    if (!ids.size) return msg('Bitte mindestens eine Kategorie wählen.');
    const affect = $('ex-affect').checked;
    if (old) Object.assign(old, { name, date, ids: [...ids], affect });
    else exams.push({ id: uid(), name, date, ids: [...ids], affect, progress: {} });
    savePool();
    $('exam-dialog').close();
    renderExams();
}

/* ================= Trainer ================= */
function loadPrefs() {
    try {
        const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
        return { q: QMODES.includes(p.q) ? p.q : 'translate', practice: !!p.practice };
    } catch (e) {
        return { q: 'translate', practice: false };
    }
}
function savePrefs(q, practice) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ q, practice })); } catch (e) { /* egal */ }
}

function resetCounters() {
    sessionDone = new Set();
    mistakeCount = 0;
    answeredCount = 0;
    promoted = 0;
    demoted = 0;
}

function buildList(kind) {
    if (kind === 'daily') {
        const { review, fresh } = dueList(selectedItems());
        return [...review, ...fresh];
    }
    if (kind === 'trouble') return troubleList(selectedItems()).slice(0, 20);
    if (kind === 'exam') {
        const ex = exams.find((e) => e.id === pendingExamId);
        return ex && examDays(ex) >= 0 ? examDueItems(ex) : [];
    }
    return selectedItems();
}

/** Prüft, ob es etwas zu üben gibt, und fragt dann nach der Frageart (und dem Übungsmodus) */
/** Prüft, ob es etwas zu üben gibt, und fragt dann kurz nach Frageart und Übungsmodus */
function requestSession(kind, examId) {
    pendingExamId = examId || null;
    const list = buildList(kind);
    if (!list.length) {
        if (kind === 'daily') setStatus(`Heute ist nichts mehr fällig. Nächste Wiederholung: ${nextDueText(selectedItems())}.`, 'ok');
        else if (kind === 'trouble') setStatus('Keine Problem-Vokabeln vorhanden.', 'ok');
        else if (kind === 'exam') setStatus('Für diese Prüfung ist heute nichts mehr fällig.', 'ok');
        else setStatus('Bitte mindestens einen Bereich auswählen.', 'error');
        return;
    }
    setStatus('');
    pendingKind = kind;
    const prefs = loadPrefs();
    const radio = document.querySelector(`input[name="qmode"][value="${prefs.q}"]`);
    if (radio) radio.checked = true;
    $('mode-practice').checked = prefs.practice;
    const ex = kind === 'exam' ? exams.find((e) => e.id === examId) : null;
    const titles = { daily: 'Tägliche Übung', trouble: 'Problem-Vokabeln', free: 'Freies Üben', exam: ex ? `Prüfung: ${ex.name}` : 'Prüfung' };
    $('mode-title').textContent = titles[kind];
    $('mode-count').textContent = `${list.length} Vokabeln`;
    updateModeLabels();
    const dlg = $('mode-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else launchSession(kind, prefs.q, prefs.practice);
}

function launchSession(kind, q, practice) {
    const list = buildList(kind);
    if (!list.length) { backToMain(); return; }
    if (kind === 'free' && q === 'gap' && !list.some((v) => gapInfo(v))) {
        setStatus('In den gewählten Bereichen gibt es keine Lückentexte (Satz mit Lücke und bekannter Lösung). Ergänze Lösungen unter „Listen“ oder wähle eine andere Frageart.', 'error');
        return;
    }
    qChoice = q;
    practiceMode = practice;
    sessionKind = kind;
    sessionExam = kind === 'exam' ? (exams.find((e) => e.id === pendingExamId) || null) : null;
    savePrefs(q, practice);
    resetCounters();
    setStatus('');
    const start = () => {
        if (kind === 'free') {
            sessionPool = list;
            roundQueue = q === 'mixed' ? ['translate', 'gap'] : [q];
            if (roundQueue.includes('gap') && !list.some((v) => gapInfo(v))) roundQueue = ['translate'];
            nextRound('');
        } else {
            beginSession(kind, list);
        }
    };
    // Übungsmodus: zuerst Karteikarten für alle Vokabeln in Phase 1, danach die normale Abfrage
    const cards = practice ? list.filter((v) => v.phase === 1) : [];
    if (cards.length) startCards(cards, start); else start();
}

function nextRound(notice) {
    while (roundQueue.length) {
        mode = roundQueue.shift();
        const items = sessionPool.filter((v) => mode !== 'gap' || gapInfo(v));
        if (!items.length) continue;
        activeList = shuffle([...items]);
        wrongAnswers = [];
        currentIndex = 0;
        isRetry = false;
        showScreen('trainer');
        showQuestion(notice);
        return;
    }
    finish();
}

function beginSession(kind, list) {
    sessionKind = kind;
    sessionPool = list;
    activeList = shuffle([...list]);
    wrongAnswers = [];
    roundQueue = [];
    currentIndex = 0;
    isRetry = false;
    showScreen('trainer');
    showQuestion('');
}

/* ---- Karteikarten (Übungsmodus): Karte umdrehen (Tippen oder Enter), dann weiter (Tippen, Button oder Enter) ---- */
function cardSides(item) {
    const sentence = item.sentence ? displaySentence(item) : '';
    if (qChoice === 'reverse') return { q: item.term, a: item.de, s: sentence };
    const info = gapInfo(item);
    if (qChoice === 'gap' && info) return { q: info.text, a: info.answers.join('; '), s: '' };
    return { q: item.de, a: item.term, s: sentence };
}
function startCards(list, next) {
    cardList = shuffle([...list]);
    cardIndex = 0;
    afterCards = next;
    showScreen('card');
    showCard();
}
function showCard() {
    const item = cardList[cardIndex];
    cardFlipped = false;
    const card = $('flashcard');
    card.dataset.flipped = '0';
    card.setAttribute('aria-pressed', 'false');
    $('fc-label').textContent = CARD_TEXT.front;
    $('fc-text').textContent = cardSides(item).q;
    $('card-progress').textContent = `Karte ${cardIndex + 1} von ${cardList.length}`;
    $('card-next').hidden = true;
    card.focus();
}
function flipOrNext() {
    const item = cardList[cardIndex];
    const card = $('flashcard');
    if (!cardFlipped) {
        cardFlipped = true;
        const s = cardSides(item);
        card.dataset.flipped = '1';
        card.setAttribute('aria-pressed', 'true');
        $('fc-label').textContent = CARD_TEXT.back;
        $('fc-text').textContent = s.s ? `${s.a}\n${s.s}` : s.a;
        $('card-next').hidden = false;
        card.classList.remove('flip');
        void card.offsetWidth;
        card.classList.add('flip');
        card.focus();
        return;
    }
    cardIndex++;
    if (cardIndex < cardList.length) { showCard(); return; }
    const next = afterCards;
    afterCards = null;
    if (next) next(); else backToMain();
}

function restartSession() {
    pendingExamId = sessionExam ? sessionExam.id : null;
    launchSession(sessionKind, qChoice, practiceMode);
}

function phaseTitle(item) {
    const n = LANGS[item.lang].name;
    const titles = { translate: `Deutsch → ${n}`, reverse: `${n} → Deutsch`, gap: 'Lückentext' };
    const retry = isRetry ? ', Wiederholung' : '';
    if (sessionKind === 'daily') return `Tägliche Übung, Phase ${item.phase}${retry}`;
    if (sessionKind === 'trouble') return `Problem-Vokabeln${retry}`;
    if (sessionKind === 'exam') return `Prüfung: ${sessionExam ? sessionExam.name : ''}${retry}`;
    return `${titles[qMode]}${retry}`;
}

/* Karteikarte (Übungsmodus, nur Vokabeln in Phase 1) */
function showQuestion(notice = '') {
    isShowingResolution = false;
    const item = activeList[currentIndex];
    const input = $('user-input');
    const sentenceBox = $('sentence-box');
    qMode = questionMode(item);

    input.value = '';
    input.readOnly = false;
    $('feedback-display').className = 'feedback';
    $('feedback-display').textContent = notice;
    $('action-btn').textContent = 'Antwort prüfen';
    $('stats-display').textContent = `Vokabel ${currentIndex + 1} von ${activeList.length}`;
    $('phase-title').textContent = phaseTitle(item);
    sentenceBox.hidden = true;

    if (qMode === 'translate') {
        $('question-display').textContent = item.de;
        input.placeholder = item.lang === 'fr' ? 'Französische Übersetzung...' : 'Englische Übersetzung...';
    } else if (qMode === 'reverse') {
        $('question-display').textContent = item.term;
        input.placeholder = 'Deutsche Übersetzung...';
    } else {
        // Lückentext: bewusst ohne Hinweis
        const info = gapInfo(item);
        $('question-display').textContent = 'Ergänze das fehlende Wort:';
        input.placeholder = info.blanks > 1 ? 'Antworten mit Komma trennen...' : 'Fehlendes Wort...';
        sentenceBox.textContent = info.text;
        sentenceBox.hidden = false;
    }
    input.focus();
}

function checkAnswer() {
    if (isShowingResolution) return advance();

    const item = activeList[currentIndex];
    const value = $('user-input').value;
    const feedback = $('feedback-display');
    let result;
    let solution = item.term;

    if (qMode === 'reverse') {
        result = judgeDe(value, item);
        solution = item.de;
    } else if (qMode === 'gap') {
        const info = gapInfo(item);
        result = judgeGap(value, info);
        if (!result && item.lang === 'en') result = judgeTerm(value, item);
        solution = info.answers.join('; ') + (item.lang === 'en' ? ` (${item.term})` : '') + (info.auto ? ' (Vorschlag)' : '');
    } else {
        result = judgeTerm(value, item);
    }

    recordAnswer(item, !!result);
    if (result) {
        feedback.className = 'feedback correct';
        if (result === 'typo') feedback.textContent = `Richtig (kleiner Tippfehler). Schreibweise: ${solution}`;
        else if (result === 'accent') feedback.textContent = `Richtig, aber achte auf die Akzente: ${solution}`;
        else feedback.textContent = 'Richtig!';
    } else {
        feedback.className = 'feedback wrong';
        feedback.textContent = `Falsch. Lösung: ${solution}`;
        if (!wrongAnswers.includes(item)) wrongAnswers.push(item);
    }
    savePool();

    if (item.sentence) {
        $('sentence-box').textContent = displaySentence(item);
        $('sentence-box').hidden = false;
    }
    $('user-input').readOnly = true;
    $('action-btn').textContent = 'Weiter';
    isShowingResolution = true;
}

function advance() {
    currentIndex++;
    if (currentIndex < activeList.length) return showQuestion();

    if (wrongAnswers.length) {
        activeList = shuffle([...wrongAnswers]);
        wrongAnswers = [];
        currentIndex = 0;
        isRetry = true;
        return showQuestion(`Noch ${activeList.length} Vokabeln zum Wiederholen.`);
    }
    nextRound(roundQueue.length ? 'Super! Nächste Runde: Lückentext.' : '');
}

function finish() {
    let text = `${answeredCount} Vokabeln abgefragt, ${answeredCount - mistakeCount} davon beim ersten Mal richtig.`;
    if (sessionKind === 'daily') {
        text += ` ${promoted} in eine höhere Phase, ${demoted} zurückgestuft. Nächste Wiederholung: ${nextDueText(langPool())}.`;
    }
    if (sessionKind === 'exam' && sessionExam) {
        const days = examDays(sessionExam);
        text += ` Prüfung ${days <= 0 ? 'heute' : days === 1 ? 'morgen' : `in ${days} Tagen`}, heute noch fällig: ${examDueItems(sessionExam).length}.`;
    }
    const s = streakDays();
    if (s > 0) text += ` Serie: ${s} ${s === 1 ? 'Tag' : 'Tage'}.`;
    $('end-text').textContent = text;
    showScreen('end');
    $('restart-btn').focus();
}
function backToMain() {
    showScreen('main');
    showTab(currentTab);
}

/* ================= Benachrichtigungen (Web Push) ================= */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushConfigured = () => /^[A-Za-z0-9_-]{80,}$/.test(VAPID_PUBLIC_KEY);
const userTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'; } catch (e) { return 'Europe/Berlin'; } };

function b64urlToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
const withTimeout = (promise, ms, msg) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
]);

async function getPushSub() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
}
function setPushInfo(text, type = 'busy') {
    const el = $('push-info');
    if (!el) return;
    el.textContent = text;
    el.style.color = { busy: '#4a5568', ok: '#1e8449', error: '#c0392b' }[type];
}

async function refreshPushUI() {
    try {
        const onBtn = $('push-toggle');
        const test = $('push-test');
        if (!onBtn || !test) return;
        onBtn.disabled = false;
        test.disabled = true;
        onBtn.dataset.state = 'off';
        onBtn.textContent = 'Benachrichtigungen einschalten';
        if (!account || account.guest) { onBtn.disabled = true; setPushInfo('Erinnerungen brauchen ein Konto (nicht im Gast-Modus).'); return; }
        if (!pushConfigured()) { onBtn.disabled = true; setPushInfo('Noch nicht eingerichtet: Der öffentliche VAPID-Schlüssel fehlt in app.js.', 'error'); return; }
        if (!pushSupported()) {
            onBtn.disabled = true;
            setPushInfo(isIos()
                ? 'Auf iPhone/iPad nur in der installierten App möglich (Safari: Teilen, Zum Home-Bildschirm; ab iOS 16.4).'
                : 'Dieser Browser unterstützt keine Push-Benachrichtigungen.', 'error');
            return;
        }
        if (Notification.permission === 'denied') {
            onBtn.disabled = true;
            setPushInfo('Blockiert: Erlaube Benachrichtigungen für diese Seite in den Browser- oder Systemeinstellungen.', 'error');
            return;
        }
        const sub = await getPushSub();
        if (sub && Notification.permission === 'granted') {
            onBtn.dataset.state = 'on';
            onBtn.textContent = 'Benachrichtigungen ausschalten';
            test.disabled = false;
            setPushInfo(`Aktiv: tägliche Erinnerung um ${settings.reminderTime} Uhr, wenn Vokabeln fällig sind.`, 'ok');
        } else {
            setPushInfo('Ausgeschaltet.');
        }
    } catch (e) {
        console.warn(e);
    }
}

async function savePushRow(sub) {
    const j = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({
        user_id: account.id,
        endpoint: j.endpoint,
        p256dh: j.keys.p256dh,
        auth: j.keys.auth,
        reminder_time: settings.reminderTime,
        timezone: userTimeZone(),
        enabled: true,
        user_agent: navigator.userAgent.slice(0, 200)
    }, { onConflict: 'user_id,endpoint' });
    if (error) throw error;
}
/** Hält die Serverzeile aktuell (Uhrzeit, Zeitzone) und legt sie nach einer erneuten Anmeldung wieder an */
async function ensurePushRow() {
    try {
        if (!sb || !account || account.guest || !pushConfigured() || !pushSupported() || Notification.permission !== 'granted') return;
        const sub = await getPushSub();
        if (sub) await savePushRow(sub);
    } catch (e) { console.warn('Push-Abo konnte nicht aktualisiert werden', e); }
}
async function removePushRow() {
    try {
        const sub = await getPushSub();
        if (sub && sb && account) await sb.from('push_subscriptions').delete().eq('user_id', account.id).eq('endpoint', sub.endpoint);
    } catch (e) { /* egal */ }
}

async function enablePush() {
    if (!account || account.guest || !sb) return;
    const btn = $('push-toggle');
    btn.disabled = true;
    try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { setPushInfo('Die Erlaubnis wurde nicht erteilt.', 'error'); return; }
        const reg = await withTimeout(navigator.serviceWorker.ready, 8000, 'Der Service Worker ist nicht aktiv. Seite neu laden und noch einmal versuchen.');
        const key = b64urlToBytes(VAPID_PUBLIC_KEY);
        let sub = await reg.pushManager.getSubscription();
        if (sub) {   // Abo, das mit einem anderen Schlüssel erstellt wurde, erneuern
            const cur = sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
            if (!cur || cur.length !== key.length || cur.some((b, i) => b !== key[i])) { await sub.unsubscribe(); sub = null; }
        }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await savePushRow(sub);
    } catch (e) {
        console.warn(e);
        setPushInfo(`Fehler: ${e.message || e}`, 'error');
    } finally {
        btn.disabled = false;
        refreshPushUI();
    }
}
async function disablePush() {
    try {
        const sub = await getPushSub();
        if (sub) {
            await sb.from('push_subscriptions').delete().eq('user_id', account.id).eq('endpoint', sub.endpoint);
            await sub.unsubscribe();
        }
    } catch (e) { console.warn(e); }
    refreshPushUI();
}
async function sendTestPush() {
    setPushInfo('Sende Testnachricht...');
    try {
        const { data, error } = await sb.functions.invoke('send-reminders', { body: { action: 'test' } });
        if (error) {
            let detail = error.message || String(error);
            if (error.context && typeof error.context.json === 'function') {
                try {
                    const j = await error.context.json();
                    detail = j.error || j.message || JSON.stringify(j);
                } catch (e) { /* Antwort war kein JSON */ }
            } else if (error.name === 'FunctionsFetchError') {
                detail = 'Die Funktion ist nicht erreichbar. Mögliche Ursachen: nicht bereitgestellt, Name stimmt nicht, "Verify JWT" ist noch an oder die Funktion startet nicht.';
            }
            throw new Error(detail);
        }
        if (data && data.sent) {
            setPushInfo('Testnachricht gesendet. Sie sollte gleich erscheinen.', 'ok');
        } else {
            const why = data && data.errors && data.errors.length
                ? data.errors[0]
                : (data && data.subscriptions === 0
                    ? 'Auf dem Server ist kein Abo gespeichert. Schalte die Benachrichtigungen aus und wieder ein.'
                    : 'Unbekannter Grund (siehe Funktions-Logs im Dashboard).');
            setPushInfo(`Nichts gesendet: ${why}`, 'error');
        }
    } catch (e) {
        setPushInfo(`Fehler: ${e.message || e}`, 'error');
    }
}

/* ================= PWA ================= */
let installPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function imageSize(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
        img.onerror = reject;
        img.src = `${url}${url.includes('?') ? '&' : '?'}check=${Date.now()}`;
    });
}

/** Zeigt an, welche Voraussetzung für die Installation fehlt */
async function diagnosePwa() {
    const list = $('install-report');
    const rows = [];
    const ok = (t) => rows.push(`OK: ${t}`);
    const bad = (t) => rows.push(`Fehler: ${t}`);
    list.hidden = false;
    list.replaceChildren();
    const li = document.createElement('li');
    li.textContent = 'Prüfe...';
    list.append(li);

    (window.isSecureContext ? ok : bad)('Sichere Verbindung (https)');

    const link = document.querySelector('link[rel="manifest"]');
    if (!link) {
        bad('In der index.html fehlt <link rel="manifest" href="manifest.json">.');
    } else {
        try {
            const res = await fetch(link.href, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const m = await res.json();
            ok('manifest.json gefunden und lesbar');
            (m.display === 'standalone' || m.display === 'fullscreen' || m.display === 'minimal-ui' ? ok : bad)(`display = ${m.display || 'nicht gesetzt'}`);
            (m.name || m.short_name ? ok : bad)('Name im Manifest');
            let has192 = false;
            let has512 = false;
            for (const icon of m.icons || []) {
                const url = new URL(icon.src, link.href).href;
                try {
                    const [w, h] = await imageSize(url);
                    ok(`${icon.src} geladen (${w}x${h})`);
                    if (w >= 192 && h >= 192) has192 = true;
                    if (w >= 512 && h >= 512) has512 = true;
                } catch (e) {
                    bad(`${icon.src} lässt sich nicht laden (Datei fehlt oder ist kein Bild)`);
                }
            }
            if (!has192) bad('Kein gültiges Icon mit mindestens 192x192 Pixeln.');
            if (!has512) bad('Kein gültiges Icon mit mindestens 512x512 Pixeln.');
        } catch (e) {
            bad(`manifest.json lässt sich nicht laden (${e.message})`);
        }
    }

    if (!('serviceWorker' in navigator)) {
        bad('Dieser Browser unterstützt keinen Service Worker.');
    } else {
        try {
            const reg = await navigator.serviceWorker.getRegistration();
            if (!reg) bad('Service Worker ist nicht registriert (liegt sw.js neben der index.html?).');
            else if (reg.active) ok('Service Worker aktiv');
            else bad('Service Worker ist registriert, aber noch nicht aktiv. Seite neu laden.');
        } catch (e) {
            bad('Service Worker konnte nicht geprüft werden.');
        }
    }

    (installPrompt ? ok : bad)(installPrompt
        ? 'Der Browser bietet die Installation an'
        : 'Der Browser hat die Installation noch nicht angeboten (nur Chrome und Edge; bei Safari über Teilen, Zum Home-Bildschirm)');

    list.replaceChildren();
    rows.forEach((t) => {
        const item = document.createElement('li');
        item.textContent = t;
        list.append(item);
    });
}

function setupPwa() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker fehlgeschlagen', err));
        });
    }
    const DISMISS_KEY = 'vokabeltrainer.installDismissed';
    const bar = $('install-bar');
    const btn = $('install-btn');
    const info = $('install-info');
    let dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { /* egal */ }
    if (isStandalone() || dismissed) return;

    info.textContent = isIos()
        ? 'iPhone/iPad: In Safari auf Teilen tippen, dann „Zum Home-Bildschirm“.'
        : 'Wenn kein Button erscheint: Browser-Menü öffnen und „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen.';
    bar.hidden = false;

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        installPrompt = e;
        btn.hidden = false;
        info.textContent = 'Diese App lässt sich auf dem Gerät installieren.';
    });
    window.addEventListener('appinstalled', () => { installPrompt = null; bar.hidden = true; });
    btn.addEventListener('click', async () => {
        if (!installPrompt) return;
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => {});
        installPrompt = null;
        bar.hidden = true;
    });
    $('install-check').addEventListener('click', diagnosePwa);
    $('install-dismiss').addEventListener('click', () => {
        bar.hidden = true;
        try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* egal */ }
    });
}

/* ================= Hilfetexte: kleines i mit Popup (Hover, Fokus oder Tippen) ================= */
function setupInfo() {
    const pop = $('info-pop');
    if (!pop) return;
    let current = null;
    let sticky = false;
    const hide = () => {
        pop.hidden = true;
        if (current) { current.setAttribute('aria-expanded', 'false'); current.removeAttribute('aria-describedby'); }
        current = null;
        sticky = false;
    };
    const show = (btn) => {
        if (current && current !== btn) current.setAttribute('aria-expanded', 'false');
        current = btn;
        const host = (btn.closest && btn.closest('dialog')) || document.body;   // in Dialogen im Dialog anzeigen, sonst liegt es dahinter
        if (pop.parentNode !== host) host.append(pop);
        pop.textContent = btn.dataset.info || '';
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        btn.setAttribute('aria-describedby', 'info-pop');
        const r = btn.getBoundingClientRect();
        pop.style.maxWidth = `${Math.min(300, window.innerWidth - 24)}px`;
        const w = pop.offsetWidth, h = pop.offsetHeight;
        const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
        let top = r.top - h - 8;
        if (top < 8) top = r.bottom + 8;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
    };
    const infoBtn = (e) => (e.target && e.target.closest ? e.target.closest('.info-btn') : null);
    document.addEventListener('click', (e) => {
        const b = infoBtn(e);
        if (b) {
            e.preventDefault();
            e.stopPropagation();
            if (current === b && sticky) hide(); else { show(b); sticky = true; }
        } else if (current) hide();
    });
    document.addEventListener('pointerover', (e) => { const b = infoBtn(e); if (b && e.pointerType === 'mouse' && !sticky) show(b); });
    document.addEventListener('pointerout', (e) => { const b = infoBtn(e); if (b && e.pointerType === 'mouse' && !sticky && current === b) hide(); });
    document.addEventListener('focusin', (e) => { const b = infoBtn(e); if (b && !sticky) show(b); });
    document.addEventListener('focusout', () => { if (current && !sticky) hide(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) hide(); });
    window.addEventListener('scroll', () => { if (current) hide(); }, true);
}

/** Fehlende französische Lücken-Lösungen mit dem Wörterbuch vorschlagen */
async function fillGapsClick() {
    setStatus('Lade das französische Wörterbuch...');
    const st = await ensureDicts(['fr']);
    if (!st.fr) { setStatus('Das französische Wörterbuch konnte nicht geladen werden.', 'error'); return; }
    const n = fillGapSuggestions('fr');
    refreshAll();
    setStatus(n ? `${n} Lücken-Lösungen vorgeschlagen (als „Bitte prüfen“ markiert, alle passenden Formen gelten als richtig).` : 'Es gibt keine fehlenden Lücken-Lösungen, die sich vorschlagen lassen.', n ? 'ok' : 'busy');
}

/* ================= Init ================= */
function showError(text) {
    if (!$('main-screen').hidden) setStatus(text, 'error');
    else { const el = $('login-msg'); el.textContent = text; el.hidden = false; }
}

function init() {
    // Fehler sichtbar machen statt still zu scheitern
    window.addEventListener('error', (ev) => showError(`Skriptfehler: ${ev.message}`));
    window.addEventListener('unhandledrejection', (ev) => showError(`Fehler: ${(ev.reason && ev.reason.message) || ev.reason}`));

    // Login
    $('login-form').addEventListener('submit', (e) => { e.preventDefault(); authSubmit('login'); });
    $('register-btn').addEventListener('click', () => authSubmit('register'));
    $('guest-btn').addEventListener('click', () => {
        enterAccount({ name: '', guest: true }).catch((e) => { console.error(e); showError(`Start fehlgeschlagen: ${e.message || e}`); });
    });
    $('logout-btn').addEventListener('click', logout);

    // Sprache & Tabs
    document.querySelectorAll('.lang-btn').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

    // Üben: jede Art von Übung fragt kurz nach Frageart und Übungsmodus
    $('daily-btn').addEventListener('click', () => requestSession('daily'));
    $('trouble-btn').addEventListener('click', () => requestSession('trouble'));
    $('start-btn').addEventListener('click', () => requestSession('free'));
    $('sel-all').addEventListener('click', () => { deselected.clear(); renderLearn(); });
    $('sel-none').addEventListener('click', () => {
        langPool().forEach((v) => deselected.add(groupKey(v)));
        renderLearn();
    });
    $('mode-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const checked = document.querySelector('input[name="qmode"]:checked');
        const q = checked ? checked.value : 'translate';
        const practice = $('mode-practice').checked;
        const kind = pendingKind;
        pendingKind = null;
        $('mode-dialog').close();
        if (kind) launchSession(kind, q, practice);
    });
    $('mode-cancel').addEventListener('click', () => { pendingKind = null; $('mode-dialog').close(); });
    // Karteikarten (Übungsmodus)
    $('flashcard').addEventListener('click', flipOrNext);
    $('card-next').addEventListener('click', flipOrNext);
    $('card-quit').addEventListener('click', () => { afterCards = null; backToMain(); });

    // Prüfungen
    $('exam-new').addEventListener('click', () => openExamDialog(null));
    $('exam-form').addEventListener('submit', (e) => { e.preventDefault(); saveExam(); });
    $('ex-cancel').addEventListener('click', () => $('exam-dialog').close());
    $('pick-form').addEventListener('submit', (e) => { e.preventDefault(); confirmPick(); });
    $('pick-cancel').addEventListener('click', () => $('pick-dialog').close());

    // Kategorien und Auswahl in den Listen
    $('select-btn').addEventListener('click', () => setSelectMode(!selectMode));
    $('sel-cancel').addEventListener('click', () => setSelectMode(false));
    $('sel-move').addEventListener('click', () => openMoveDialog('items'));
    $('sel-exam').addEventListener('click', openPickExam);
    $('sel-delete').addEventListener('click', deleteSelected);
    $('move-form').addEventListener('submit', (e) => { e.preventDefault(); confirmMove(); });
    $('mv-cancel').addEventListener('click', () => { moveCtx = null; $('move-dialog').close(); });
    $('mv-existing').addEventListener('change', (e) => {
        if (!e.target.value) return;
        let p = [];
        try { p = JSON.parse(e.target.value); } catch (err) { /* egal */ }
        [0, 1, 2].forEach((i) => setVal(`mv-${i + 1}`, p[i] || ''));
    });
    on('gaps-fill-btn', 'click', fillGapsClick);
    setupInfo();

    // Einstellungen und Erinnerungen
    ['iv-1', 'iv-2', 'iv-3', 'iv-4', 'iv-5', 'iv-6', 'set-wrong', 'set-goal', 'set-time']
        .forEach((id) => on(id, 'change', readSettingsUI));
    on('settings-reset', 'click', () => {
        settings = sanitizeSettings(DEFAULT_SETTINGS);
        syncSettingsUI();
        savePool();
        renderToday();
        ensurePushRow();
    });
    on('push-toggle', 'click', () => ($('push-toggle').dataset.state === 'on' ? disablePush() : enablePush()));
    on('push-test', 'click', sendTestPush);

    // Listen
    let searchTimer = null;
    $('list-search').addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { listQuery = e.target.value; renderLists(); }, 200);
    });
    on('only-warn', 'change', (e) => { onlyWarn = e.target.checked; renderLists(); });
    $('expand-btn').addEventListener('click', () => document.querySelectorAll('#list-tree details').forEach((d) => { d.open = true; }));
    $('collapse-btn').addEventListener('click', () => document.querySelectorAll('#list-tree details').forEach((d) => { d.open = false; }));
    $('export-btn').addEventListener('click', exportBackup);
    $('import-btn').addEventListener('click', () => $('import-input').click());
    $('import-input').addEventListener('change', (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (f) importBackup(f);
    });
    $('clear-btn').addEventListener('click', () => {
        const btn = $('clear-btn');
        if (!clearTimer) {
            btn.textContent = 'Wirklich alles löschen? Nochmal klicken';
            clearTimer = setTimeout(() => { clearTimer = null; updateAddLabels(); }, 4000);
            return;
        }
        clearTimeout(clearTimer);
        clearTimer = null;
        vocabularyPool = vocabularyPool.filter((v) => v.lang !== currentLang);
        rebuildProtected();
        savePool();
        refreshAll();
        setStatus('Liste geleert.', 'ok');
    });

    // Hinzufügen: Upload, Kamera, manuell
    const fileInput = $('file-input');
    const zone = $('upload-zone');
    fileInput.addEventListener('change', () => {
        const files = [...fileInput.files];
        fileInput.value = '';
        handleBatchUpload(files);
    });
    zone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('drop', (e) => { e.preventDefault(); handleBatchUpload(e.dataTransfer.files); });
    $('camera-btn').addEventListener('click', openCamera);
    $('cam-input').addEventListener('change', (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        handleBatchUpload(files);
    });
    $('cam-shot').addEventListener('click', takeShot);
    $('cam-done').addEventListener('click', () => {
        const shots = camShots;
        camShots = [];
        $('camera-dialog').close();
        if (shots.length) handleBatchUpload(shots);
    });
    $('cam-cancel').addEventListener('click', () => { camShots = []; $('camera-dialog').close(); });
    $('camera-dialog').addEventListener('close', stopCamera);

    $('manual-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const term = $('m-term').value.trim();
        const de = $('m-de').value.trim();
        const sentence = normGapMarks($('m-sent').value.trim());
        if (!term || !de) return;
        const cnt = countGaps(sentence);
        const ans = $('m-gaps').value.split(';').map((s) => s.trim());
        const item = makeItem({
            term, de, sentence,
            gaps: Array.from({ length: cnt }, (_, i) => ({ n: null, a: ans[i] || '' })),
            path: readPathFields().filter(Boolean)
        }, currentLang);
        if (!item) return;
        if (vocabularyPool.some((v) => sameVocab(v, item))) { setStatus('Diese Vokabel gibt es schon.', 'busy'); return; }
        vocabularyPool.push(item);
        addConfirmed(`${term} ${de} ${sentence}`);
        rebuildProtected();
        savePool();
        refreshAll();
        $('manual-form').reset();
        $('m-term').focus();
        setStatus(`„${term}“ hinzugefügt.`, 'ok');
    });

    // Trainer
    $('action-btn').addEventListener('click', checkAnswer);
    $('user-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); checkAnswer(); }
    });
    $('quit-btn').addEventListener('click', backToMain);
    $('restart-btn').addEventListener('click', restartSession);
    $('back-btn').addEventListener('click', backToMain);

    // Beim Zurückkehren in den Tab Änderungen anderer Geräte holen, beim Verlassen speichern
    document.addEventListener('visibilitychange', () => {
        if (!account || account.guest) return;
        if (document.hidden) {
            if (syncMeta.dirty) { clearTimeout(saveTimer); pushToCloud(); }
        } else if (!syncMeta.dirty && !saving && !isScanning && !$('main-screen').hidden) {
            syncOnLogin();
        }
    });

    // Sitzung wiederherstellen
    showScreen('login');
    if (sessionStorage.getItem(SESSION_KEY) === 'guest') {
        enterAccount({ name: '', guest: true }).catch((e) => showError(`Start fehlgeschlagen: ${e.message || e}`));
        return;
    }
    if (sb) {
        sb.auth.getSession().then(({ data }) => {
            const u = data && data.session && data.session.user;
            if (u) return enterAccount({ id: u.id, name: (u.email || '').split('@')[0], guest: false });
        }).catch((e) => console.warn('Sitzung konnte nicht wiederhergestellt werden', e));
    }
}

setupPwa();
init();
