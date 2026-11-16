'use strict';

/* ================= Konstanten & State ================= */
const SESSION_KEY = 'vokabeltrainer.session';
const MODE_KEY = 'vokabeltrainer.mode';
const LANG_KEY = 'vokabeltrainer.lang';
const OLD_POOL_KEY = 'vokabeltrainer.pool.v1';
const GAP = '_____';
const $ = (id) => document.getElementById(id);

const LANGS = {
    fr: { name: 'Französisch', ocr: 'fra+deu', dict: ['fr', 'de'] },
    en: { name: 'Englisch', ocr: 'eng+deu', dict: ['en', 'de'] }
};

let account = null;
let currentLang = 'fr';
let currentTab = 'learn';
let vocabularyPool = [];            // alle Sprachen: {id, lang, term, de, sentence, gaps, path, phase, due, ok, bad, fix?}
const confirmedWords = new Set();   // vom Nutzer bestätigte Wörter: nie automatisch ändern
let protectedWords = new Set();     // Wörter aus Stichwörtern: nie automatisch ändern
const deselected = new Set();       // abgewählte Bereiche beim Üben
const openSections = new Set();
let listQuery = '';

let sessionPool = [];
let activeList = [];
let wrongAnswers = [];
let roundQueue = [];
let currentIndex = 0;
let mode = 'translate';             // 'translate' | 'reverse' | 'gap'
let isRetry = false;
let isShowingResolution = false;
let mistakeCount = 0;
let answeredCount = 0;
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

function setStatus(msg, type = 'busy') {
    const el = $('status-text');
    el.hidden = !msg;
    el.textContent = msg;
    el.style.color = { busy: '#b9770e', ok: '#1e8449', error: '#c0392b' }[type];
}
function showScreen(name) {
    ['login', 'main', 'trainer', 'end'].forEach((n) => { $(`${n}-screen`).hidden = n !== name; });
}
function showTab(name) {
    currentTab = name;
    ['learn', 'lists', 'add'].forEach((n) => {
        $(`view-${n}`).hidden = n !== name;
        $(`tab-${n}`).setAttribute('aria-selected', String(n === name));
    });
    if (name === 'learn') renderLearn();
    else if (name === 'lists') renderLists();
    else updatePathSuggest();
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
    $('m-term-label').textContent = `${LANGS[currentLang].name} (z. B. ${currentLang === 'fr' ? 'le raté / la ratée' : 'to tower'})`;
    const n = langPool().length;
    $('clear-btn').textContent = `🗑 Alle ${LANGS[currentLang].name === 'Französisch' ? 'französischen' : 'englischen'} Vokabeln löschen`;
    $('clear-btn').hidden = n === 0;
    $('export-btn').hidden = vocabularyPool.length === 0;
}

/* ================= Daten bereinigen ================= */
const clampInt = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

function sanitizePool(arr) {
    return (Array.isArray(arr) ? arr : []).map((v) => {
        if (!v) return null;
        const term = String(v.term ?? v.en ?? '').trim();   // v.en: Format der alten Version
        const de = String(v.de ?? '').trim();
        if (!term || !de) return null;
        return {
            id: String(v.id || uid()),
            lang: v.lang === 'fr' ? 'fr' : 'en',
            term,
            de,
            sentence: normGapMarks(v.sentence || ''),
            gaps: Array.isArray(v.gaps) ? v.gaps.map((g) => ({ n: Number.isFinite(g && g.n) ? g.n : null, a: String((g && g.a) || '') })) : [],
            path: Array.isArray(v.path) ? v.path.map((p) => String(p).trim()).filter(Boolean).slice(0, 3) : [],
            fix: Array.isArray(v.fix) && v.fix.length ? v.fix : undefined,
            phase: clampInt(v.phase, 1, 6, 1),
            due: Number(v.due) || 0,
            ok: Number(v.ok) || 0,
            bad: Number(v.bad) || 0
        };
    }).filter(Boolean);
}
function rebuildProtected() {
    protectedWords = new Set();
    vocabularyPool.forEach((v) => letters(v.term).forEach((w) => protectedWords.add(w)));
}
const isProtected = (w) => protectedWords.has(w) || confirmedWords.has(w);
const addConfirmed = (text) => letters(text).forEach((w) => confirmedWords.add(w));

/* ================= Konten & Speicherung (Supabase) ================= */
const SUPABASE_URL = 'https://tjdgptcdlaaonuiogbzn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_3qPEGh16ss9PzCWpJjuAeQ_zxwTPupX';
const AUTH_DOMAIN = 'vokabeltrainer.app';   // nur für die interne Pseudo-E-Mail, es wird nie eine Mail versendet
const sb = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

let syncMeta = { base: null, dirty: false };
let changeSeq = 0;
let saveTimer = null;
let saving = false;
let syncBlocked = false;

const SYNC_TEXT = {
    saved: '☁ gespeichert',
    saving: '☁ speichert…',
    dirty: '☁ ungespeichert',
    offline: '⚠ offline, wird später gespeichert',
    conflict: '⚠ Konflikt',
    none: ''
};
function setSync(state) {
    const el = $('sync-state');
    if (el) el.textContent = SYNC_TEXT[state] ?? '';
}

const dataKey = () => `vokabeltrainer.data.v2.${account.guest ? 'guest' : account.id}`;
const payload = () => ({ v: 2, pool: vocabularyPool, confirmed: [...confirmedWords] });

function writeCache() {
    try {
        localStorage.setItem(dataKey(), JSON.stringify({ ...payload(), base: syncMeta.base, dirty: syncMeta.dirty }));
    } catch (e) {
        setStatus('⚠ Lokales Speichern nicht möglich (Speicher voll oder privater Modus).', 'error');
    }
}
function loadLocal() {
    vocabularyPool = [];
    confirmedWords.clear();
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
    syncMeta = { base: row.updated_at, dirty: false };
    rebuildProtected();
    writeCache();
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
    $('account-name').textContent = acc.guest ? '👤 Gast (nur dieses Gerät)' : `👤 ${acc.name}`;
    $('login-pass').value = '';
    setStatus('');
    setSync(acc.guest ? 'none' : (syncMeta.dirty ? 'dirty' : 'saved'));

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
    if (!acc.guest) await syncOnLogin();
}

async function logout() {
    clearTimeout(saveTimer);
    if (account && !account.guest) {
        if (syncMeta.dirty) await pushToCloud();
        if (syncMeta.dirty && !confirm('Es gibt Änderungen, die noch nicht in der Cloud gespeichert sind. Trotzdem abmelden? Diese Änderungen gehen verloren.')) return;
        try { localStorage.removeItem(dataKey()); } catch (e) { /* egal */ }
        if (sb) { try { await sb.auth.signOut(); } catch (e) { /* egal */ } }
    }
    sessionStorage.removeItem(SESSION_KEY);
    account = null;
    vocabularyPool = [];
    confirmedWords.clear();
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
    if (!sb) return msg('Der Konto-Dienst konnte nicht geladen werden (Internet prüfen).');
    const name = $('login-user').value.trim().toLowerCase();
    const pw = $('login-pass').value;
    if (!/^[a-z0-9_.-]{3,24}$/.test(name)) return msg('Benutzername: 3–24 Zeichen (Buchstaben, Zahlen, _ . -).');
    if (pw.length < 6) return msg('Das Passwort braucht mindestens 6 Zeichen.');

    const buttons = $('login-form').querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    msg('');
    try {
        const email = `${name}@${AUTH_DOMAIN}`;
        const res = kind === 'register'
            ? await sb.auth.signUp({ email, password: pw })
            : await sb.auth.signInWithPassword({ email, password: pw });
        if (res.error) return msg(authErrorText(res.error));
        const user = res.data.user;
        if (kind === 'register' && user && user.identities && !user.identities.length) return msg('Diesen Benutzernamen gibt es schon.');
        if (!res.data.session) return msg('Konto angelegt, aber keine Anmeldung möglich: In Supabase muss „Confirm email“ ausgeschaltet sein.');
        await enterAccount({ id: user.id, name, guest: false });
    } catch (e) {
        msg('Verbindung zum Konto-Dienst fehlgeschlagen.');
    } finally {
        buttons.forEach((b) => { b.disabled = false; });
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
        rebuildProtected();
        savePool();
        refreshAll();
        setStatus(`✅ Sicherung geladen: ${added} neue Vokabeln.`, 'ok');
    } catch (e) {
        setStatus('❌ Die Datei konnte nicht gelesen werden.', 'error');
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

/** Akzent-Index (fehlende Akzente wiederherstellen), nur bei eindeutigem Treffer */
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

function suggestWord(word, lang, conf) {
    const d = dicts[lang];
    const w = word.toLowerCase();
    if (!d || w.length < 3 || SKIP_WORDS.has(w) || isProtected(w) || isKnown(w, lang)) return null;

    // 1) rn↔m usw.: Ergebnis muss ein echtes Wörterbuchwort sein, genau ein Treffer
    if (conf < CONFUSION_CONF[lang]) {
        const vs = variants(w).filter((v) => d.has(v));
        if (vs.length === 1) return vs[0];
        if (vs.length > 1) return null;
    }
    // 2) fehlende Akzente (Französisch)
    if (lang === 'fr' && w.length >= 4 && conf < 95) {
        const c = accentIndex('fr').get(w);
        if (c) return c;
    }
    // 3) Einzelbuchstaben-Fehler, nur bei sehr unsicherer Erkennung
    if (w.length >= 5 && conf < EDIT_CONF[lang]) {
        const cands = [...edits1(w, lang)].filter(([c]) => d.has(c));
        if (!cands.length) return null;
        const min = Math.min(...cands.map(([, s]) => s));
        const best = cands.filter(([, s]) => s === min);
        return best.length === 1 ? best[0][0] : null;     // mehrdeutig → nichts ändern
    }
    return null;
}

function matchCase(src, dst) {
    if (src.length > 1 && src === src.toUpperCase()) return dst.toUpperCase();
    if (src[0] !== src[0].toLowerCase()) return dst[0].toUpperCase() + dst.slice(1);
    return dst;
}

function dictCorrect(text, lang, confMap, label, notes, skipProper, skipStem) {
    if (!dicts[lang] || !text) return text;
    return text.replace(/\p{L}+/gu, (tok, offset) => {
        const low = tok.toLowerCase();
        if (skipProper && offset > 0 && tok[0] !== low[0]) return tok;     // Eigennamen
        if (skipStem && low.startsWith(skipStem)) return tok;              // passt zum Stichwort
        const sug = suggestWord(tok, lang, confMap[low] ?? 70);
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
    if (tokens.some((m) => m[0].toLowerCase().startsWith(stem))) return;   // Stichwort kommt vor → nichts tun

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

function refineEntry(e, confs, lang) {
    const notes = [];
    const labels = { term: 'Stichwort', de: 'Deutsch', sentence: 'Satz' };
    // Zeichenverwechslungen mitten im Wort (0→o, 1/|→l, großes I→l)
    const fixChars = (s) => s
        .replace(/(\p{L})0(?=\p{L})/gu, '$1o')
        .replace(/(\p{L})[1|](?=\p{L})/gu, '$1l')
        .replace(/(\p{Ll})I(?=\p{Ll})/gu, '$1l');
    for (const key of ['term', 'de', 'sentence']) {
        const fixed = fixChars(e[key]);
        if (fixed !== e[key]) { notes.push(`${labels[key]}: „${e[key]}“ → „${fixed}“`); e[key] = fixed; }
    }
    if (autofixOn()) {
        letters(e.term).forEach((w) => protectedWords.add(w));       // Stichwort ist maßgeblich
        if (lang === 'en') adaptSentence(e, confs.sent, notes);
        const stem = lang === 'en' ? stemOf(coreWord(e.term)) : '';
        e.de = dictCorrect(e.de, 'de', confs.de, 'Deutsch', notes, false, '');
        e.sentence = dictCorrect(e.sentence, lang, confs.sent, 'Satz', notes, true, stem);
    }
    if (notes.length) e.fix = notes;
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
        const v = lumOf(px[o], px[o + 1], px[o + 2]) > 170 ? 0 : 255;   // heller Text → schwarz
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
    const on = new Array(h).fill(false);
    for (let y = 0; y < h; y++) {
        let c = 0;
        let o = y * w * 4;
        for (let x = 0; x < w; x++, o += 4) {
            const r = d[o], g = d[o + 1], b = d[o + 2];
            if (g > 120 && g - r > 35 && g - b > 45) c++;
        }
        on[y] = c > w * 0.45;
    }
    const lines = [];
    const gap = Math.max(3, Math.round(h * 0.002));
    for (let y = 0; y < h; y++) {
        if (!on[y]) continue;
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

/** Ein Bild → 1 oder 2 Seiten (Doppelseiten werden geteilt) */
async function preparePages(file) {
    const bmp = await createImageBitmap(file);
    try {
        let rects = [[0, bmp.width]];
        if (bmp.width / bmp.height > 1.25) {
            const sx = Math.round(findSplitX(bmp) * bmp.width);
            rects = [[0, sx], [sx, bmp.width - sx]];
        }
        const pages = [];
        let boxes = 0;
        for (const [x, w] of rects) {
            const canvas = canvasFromBitmap(bmp, x, 0, w, bmp.height, 2200);
            const header = extractHeader(canvas);
            boxes += maskGreenBoxes(canvas.getContext('2d', { willReadFrequently: true }), canvas.width, canvas.height);
            normalizeCanvas(canvas);
            pages.push({ canvas, header });
        }
        return { pages, boxes };
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
    files = [...files].filter((f) => f.type.startsWith('image/'));
    if (!files.length || isScanning) return;
    if (typeof Tesseract === 'undefined') {
        setStatus('❌ Texterkennung konnte nicht geladen werden (Internet prüfen).', 'error');
        return;
    }

    isScanning = true;
    showPreviews(files);
    const lang = currentLang;
    const L = LANGS[lang];
    let dictState = {};
    if (autofixOn()) {
        setStatus('⏳ Lade Wörterbücher (einmalig, einige MB)…');
        dictState = await ensureDicts(L.dict);
    }
    setStatus('⏳ Initialisiere Texterkennung (beim ersten Mal ein größerer Download)…');

    const ctx = makeContext();
    let step = '';
    let failed = 0, added = 0, solved = 0, boxes = 0;
    let worker;
    try {
        worker = await Tesseract.createWorker(L.ocr, 1, {
            logger: (m) => {
                if (m.status === 'recognizing text') setStatus(`⏳ ${step}: ${Math.round(m.progress * 100)} %`);
            }
        });
        for (let i = 0; i < files.length; i++) {
            step = `Bild ${i + 1}/${files.length}`;
            setStatus(`⏳ Bereite ${step} vor…`);
            try {
                const prep = await preparePages(files[i]);
                boxes += prep.boxes;
                for (let p = 0; p < prep.pages.length; p++) {
                    const page = prep.pages[p];
                    step = `Bild ${i + 1}/${files.length}${prep.pages.length > 1 ? `, Seite ${p + 1}/${prep.pages.length}` : ''}`;
                    const { data } = await worker.recognize(page.canvas);
                    let headerText = '';
                    if (page.header) {
                        try { headerText = (await worker.recognize(page.header)).data.text || ''; } catch (e) { /* ohne Seitenkopf weiter */ }
                    }
                    const res = parsePage(data.words || [], page.canvas.width, headerText, ctx, lang);
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
        setStatus('❌ Die Texterkennung konnte nicht gestartet werden.', 'error');
        isScanning = false;
        return;
    } finally {
        if (worker) await worker.terminate();
    }

    isScanning = false;
    refreshAll();
    const dictNote = autofixOn() && L.dict.some((l) => !dictState[l]) ? ' Wörterbuch nicht vollständig geladen, Korrektur eingeschränkt.' : '';
    if (added) {
        const areas = [...ctx.seen].slice(0, 6).join(', ') || 'keine erkannt';
        setStatus(`✅ ${added} neue Vokabeln erkannt${solved ? `, ${solved} Lücken-Lösungen zugeordnet` : ''}${boxes ? `, ${boxes} Kasten entfernt` : ''}${failed ? `, ${failed} Bild(er) fehlgeschlagen` : ''}. Bereiche: ${areas}.${dictNote} Bitte unter „Listen“ kurz kontrollieren.`, 'ok');
    } else {
        setStatus(`❌ Keine neuen Vokabeln erkannt${failed ? ` (${failed} Bild(er) fehlgeschlagen)` : ''}. Prüfe, ob die richtige Sprache oben gewählt ist, und nutze gut lesbare Seiten mit 3 Spalten.`, 'error');
    }
}

function makeItem(e, lang) {
    return sanitizePool([{ ...e, id: uid(), lang }])[0] || null;
}
function addEntries(entries, lang) {
    let added = 0;
    entries.forEach((e) => {
        const item = makeItem(e, lang);
        if (item && !vocabularyPool.some((v) => sameVocab(v, item))) { vocabularyPool.push(item); added++; }
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
                if (!g.a && g.n != null && map[g.n]) { g.a = map[g.n]; n++; }
            });
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
    const startRe = lang === 'fr' ? /^[[{|,;ˈˌ]/ : /^[[({|,;'’ˈˌ]/;
    const kept = [];
    for (const tok of tokens) {
        const br = tok.indexOf('[');
        if (br > 0) { kept.push(tok.slice(0, br)); break; }
        if (startRe.test(tok) || /\]$/.test(tok) || PHON_CHARS.test(tok) || /\w:|:\w/.test(tok)) break;
        kept.push(tok.replace(/,$/, ''));
        if (/,$/.test(tok)) break;
    }
    return kept.filter((t) => !GRAM_TAGS.test(t)).join(' ')
        .replace(/[^\p{L}\s/.'’()-]/gu, '')
        .replace(/\s*\/\s*/g, ' / ')
        .replace(/\s+/g, ' ')
        .replace(/[.\s]+$/, '')
        .trim();
}

/** Deutsch: Bindestrich am Zeilenende = Silbentrennung */
function joinHyphenated(lines) {
    let out = '';
    for (const l of lines) out = out.endsWith('-') ? out.slice(0, -1) + l : out + (out ? ' ' : '') + l;
    return out.replace(/\s+/g, ' ').trim();
}
/** Französisch: "porte-" + "monnaie" bleibt "porte-monnaie", ein losgelöstes "-" ist eine Lücke */
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

/** Beispielsatz = Zeilen bis zum ersten Zusatz (Fr./Lat., Pfeile, "x = y" nach dem Satz) */
function extractSentence(lines, lang) {
    const out = [];
    for (const l of lines) {
        if (/^(Fr|Lat)\.?\s/i.test(l) || ARROW_RE.test(l)) break;
        if (out.length && /\s=\s/.test(l)) break;
        out.push(l);
    }
    return fixPunct(lang === 'fr' ? joinFrench(out) : joinHyphenated(out));
}

/** Lücken des Buchs ("-" + hochgestellte Nummer) → "_____", Nummern merken */
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
        const m = t.match(/^((?:\S*?['’])?)([-–—‑−]+)([⁰¹²³⁴⁵⁶⁷⁸⁹]+|\d{1,2})?([.,;:!?»”)"]*)$/);
        if (m) {
            const [, prefix, dashes, num, trail] = m;
            const plain = /^[-‑−]+$/.test(dashes);
            const prevEnds = i === 0 || /[.?!»"”:]$/.test(toks[i - 1]);
            // Ein alleinstehender Gedankenstrich (– / —) am Satzanfang oder nach Satzende ist ein Dialogstrich, keine Lücke
            if (num || plain || prefix || !prevEnds) {
                const gap = { n: num ? supToNum(num) : null, a: '' };
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

/* ---- Überschriften (Gliederung) ---- */
const HEAD_PATTERNS = [
    { re: /unit[ée]\s*(\d{1,2})\b/i, level: 0, name: (m) => `Unité ${m[1]}` },
    { re: /\bunit\s*(\d{1,2})\b/i, level: 0, name: (m) => `Unit ${m[1]}` },
    { re: /\bvolet\s*(\d{1,2})\b/i, level: 1, name: (m) => `Volet ${m[1]}` },
    { re: /\bmots en contexte\b/i, level: 1, name: () => 'Mots en contexte' },
    { re: /\btexts?\s*([a-z0-9])\b/i, level: 1, name: (m) => `Texts ${m[1].toUpperCase()}` },
    { re: /\bintroduction\b/i, level: 1, name: () => 'Introduction' },
    { re: /\bsection\s*([a-z0-9])\b/i, level: 1, name: (m) => `Section ${m[1].toUpperCase()}` },
    { re: /\bmodule\s*([a-z0-9])\b/i, level: 2, name: (m) => `Module ${m[1].toUpperCase()}` }
];
function parseHeading(text) {
    const t = String(text).replace(/[|¦│]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 80) return [];
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

/* ---- Lösungskästen ("1 s'allume 2 rejoins …") ---- */
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

function parsePage(rawWords, pageW, headerText, ctx, lang) {
    const result = { entries: [], solutions: [] };
    const words = rawWords
        .map((w) => ({ t: (w.text || '').trim(), c: w.confidence, x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1 }))
        .filter((w) => w.t && !/^[!|•·▶►◀◄]+$/.test(w.t) && !(w.c < 15 && w.t.length <= 2));
    if (words.length < 6) return result;
    words.forEach((w) => { w.yc = (w.y0 + w.y1) / 2; });
    const medH = median(words.map((w) => w.y1 - w.y0));

    // Laufender Seitenkopf: nur als Startkontext (Zwischenüberschriften haben Vorrang)
    if (ctx.auto && !ctx.manual && headerText) {
        const hs = parseHeading(headerText);
        const l1 = hs.find((h) => h.level === 0);
        const empty = !ctx.l.some(Boolean);
        if (hs.length && (empty || (l1 && l1.name !== ctx.l[0]))) applyHeadings(ctx, hs);
    }

    const starts = findColumnStarts(words, pageW, medH);
    if (!starts) return result;
    const margin = pageW * 0.012;
    const colOf = (w) => (w.x0 >= starts[2] - margin ? 2 : w.x0 >= starts[1] - margin ? 1 : 0);

    const events = [];
    const skip = new Set();
    const pageLines = groupLines(words, medH);

    // Lösungskästen erkennen und aus der Tabelle nehmen
    const blocks = [];
    let block = null;
    pageLines.forEach((l) => {
        if (!isSolutionLine(l, medH)) return;
        if (block && l.yc - block.last < medH * 2.4) { block.lines.push(l); block.last = l.yc; }
        else { block = { lines: [l], last: l.yc }; blocks.push(block); }
    });
    blocks.forEach((b) => {
        b.lines.forEach((l) => l.words.forEach((w) => skip.add(w)));
        const map = parseSolutions(b.lines.flatMap((l) => l.words.map((w) => w.t)));
        if (Object.keys(map).length) events.push({ y: b.lines[0].yc, type: 'sol', map });
    });

    // Überschriften (nur Zeilen, die ganz in Spalte 1 stehen)
    pageLines.forEach((l) => {
        if (l.words.some((w) => skip.has(w))) return;
        if (l.words.length > 7 || l.words.some((w) => colOf(w) !== 0)) return;
        const items = parseHeading(l.text);
        if (items.length) {
            l.words.forEach((w) => skip.add(w));
            events.push({ y: l.yc, type: 'head', items });
        }
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
            if (l.yc - prev > medH * 2.2) break;
            out.push(l.text.replace(/\s+/g, ' ').trim());
            prev = l.yc;
        }
        return out;
    };

    anchors.forEach((a, i) => {
        const row = { a, top: a.yc - tol, end: anchors[i + 1] ? anchors[i + 1].yc - tol : Infinity };
        const term = parseHeadword(collect(l1, row).join(' '), lang);
        const de = fixPunct(joinHyphenated(collect(l2, row)).replace(/[|!•]/g, ''));
        const rawSent = extractSentence(collect(l3, row), lang).replace(/\|/g, 'I');
        const conv = lang === 'fr' ? convertGaps(rawSent) : { text: rawSent, gaps: [] };
        const okTerm = /^\p{L}/u.test(term) && term.split(' ').length <= 8;
        const okSent = lang === 'fr' || conv.text.length > 5;   // französische Einträge dürfen ohne Satz sein
        if (!(okTerm && de.length > 1 && okSent)) return;

        const inRow = (arr) => arr.filter((w) => w.yc >= row.top && w.yc < row.end);
        const confMap = (arr) => {
            const m = {};
            inRow(arr).forEach((w) => {
                const k = w.t.toLowerCase().replace(/[^\p{L}]/gu, '');
                if (k) m[k] = Math.min(m[k] ?? 100, w.c ?? 100);
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
        setStatus('ℹ️ Kamera-Zugriff nicht möglich, die Foto-App wird geöffnet.', 'busy');
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
const fillGaps = (s, answers) => { let i = 0; return s.replace(/_____/g, () => answers[i++] ?? '…'); };

/** Alternativen einer Lösung: "désolé/e" → désolé, désolée */
function altList(a) {
    const s = String(a).trim();
    if (!s.includes('/')) return [s];
    const parts = s.split('/').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2 && parts[1].length <= 3) return [parts[0], parts[0] + parts[1]];
    return parts;
}

function gapInfo(item) {
    const cnt = countGaps(item.sentence);
    if (cnt && item.gaps.length === cnt && item.gaps.every((g) => g.a)) {
        return { text: numberGaps(item.sentence, cnt), answers: item.gaps.map((g) => g.a), blanks: cnt };
    }
    if (!cnt) {
        const g = makeGap(item);
        if (g) return { text: g.text, answers: [g.match], blanks: 1 };
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
        const r = matchTargets(parts[i] || '', altList(info.answers[i]).map(normAns));
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

/* ================= Üben-Ansicht ================= */
function updateModeLabels() {
    const n = LANGS[currentLang].name;
    const labels = {
        translate: `Deutsch ➔ ${n}`,
        reverse: `${n} ➔ Deutsch`,
        gap: 'Lückentext (Beispielsatz, 3. Spalte)',
        both: 'Übersetzen + Lückentext nacheinander'
    };
    [...$('mode-select').options].forEach((o) => { o.textContent = labels[o.value]; });
}
function selectedItems() {
    return langPool().filter((v) => !deselected.has(groupKey(v)));
}
function updateSelCount() {
    const sel = selectedItems();
    const gapN = sel.filter((v) => gapInfo(v)).length;
    $('sel-count').textContent = `${sel.length} von ${langPool().length} Vokabeln ausgewählt · ${gapN} mit Lückentext`;
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
    [...groups.keys()].sort(naturalCompare).forEach((k) => {
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
    updateSelCount();
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

function buildItemRow(v) {
    const row = document.createElement('div');
    row.className = 'item';
    const main = document.createElement('div');
    main.className = 'item-main';
    const t = document.createElement('strong');
    t.textContent = v.term;
    const d = document.createElement('span');
    d.textContent = ` – ${v.de}`;
    main.append(t, d);
    if (v.sentence) {
        const s = document.createElement('div');
        s.className = 'item-sent';
        s.textContent = displaySentence(v);
        main.append(s);
    }
    if (v.fix && v.fix.length) {
        const note = document.createElement('div');
        note.className = 'fix-note';
        note.textContent = `✎ Automatisch korrigiert: ${v.fix.join(' · ')}`;
        main.append(note);
    }
    const acts = document.createElement('div');
    acts.className = 'item-actions';
    acts.append(
        iconButton('✎', `${v.term} bearbeiten`, () => row.replaceWith(buildEditor(v))),
        iconButton('✕', `${v.term} löschen`, () => {
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
    const langWrap = document.createElement('label');
    langWrap.className = 'field';
    const langSp = document.createElement('span');
    langSp.textContent = 'Sprache';
    const langSel = document.createElement('select');
    Object.entries(LANGS).forEach(([k, val]) => {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = val.name;
        langSel.append(o);
    });
    langSel.value = v.lang;
    langWrap.append(langSp, langSel);
    form.append(langWrap);

    const iTerm = mk(`${LANGS[v.lang].name} (Stichwort)`, v.term);
    const iDe = mk('Deutsch', v.de);
    const iSent = mk('Beispielsatz (Lücke = _____)', v.sentence);
    const iGaps = mk('Lücken-Lösung(en), mit ; trennen', v.gaps.map((g) => g.a).join('; '));
    const p1 = mk('Bereich Ebene 1', v.path[0] || '', 'dl-1');
    const p2 = mk('Bereich Ebene 2', v.path[1] || '', 'dl-2');
    const p3 = mk('Bereich Ebene 3', v.path[2] || '', 'dl-3');

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
        v.gaps = Array.from({ length: cnt }, (_, i) => ({ n: v.gaps[i] ? v.gaps[i].n : null, a: ans[i] || '' }));
        v.path = [p1.value, p2.value, p3.value].map((s) => s.trim()).filter(Boolean);
        v.fix = undefined;                                   // von Hand bestätigt
        addConfirmed(`${term} ${de} ${v.sentence}`);
        rebuildProtected();
        savePool();
        if (oldKey !== `${v.lang}|${v.path.join('>')}`) refreshAll();
        else { form.replaceWith(buildItemRow(v)); updatePathSuggest(); }
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

    [...node.children.values()].sort((a, b) => naturalCompare(a.name, b.name)).forEach((child) => {
        const path = [...prefix, child.name];
        const acts = document.createElement('span');
        acts.className = 'sec-actions';
        acts.append(
            iconButton('✎', `„${child.name}“ umbenennen`, () => renameSection(path)),
            iconButton('🗑', `„${child.name}“ löschen`, () => deleteSection(path))
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
    const items = all.filter((v) => !q || `${v.term} ${v.de} ${v.sentence}`.toLowerCase().includes(q));
    const tree = $('list-tree');
    tree.replaceChildren();
    const empty = $('list-empty');
    empty.hidden = items.length > 0;
    empty.textContent = all.length ? 'Keine Treffer.' : `Noch keine ${LANGS[currentLang].name}en Vokabeln. Füge sie im Tab „Hinzufügen“ hinzu.`.replace('Englischen', 'englischen').replace('Französischen', 'französischen');
    tree.append(renderNode(buildTree(items), [], !!q));
    updateAddLabels();
}

/* ================= Trainer ================= */
function startSession() {
    sessionPool = selectedItems();
    if (!sessionPool.length) { setStatus('Bitte mindestens einen Bereich auswählen.', 'error'); return; }
    const sel = $('mode-select').value;
    roundQueue = sel === 'both' ? ['translate', 'gap'] : [sel];
    if (roundQueue.includes('gap') && !sessionPool.some((v) => gapInfo(v))) {
        if (sel === 'gap') {
            setStatus('❌ In den gewählten Bereichen gibt es keine Lückentexte (Satz mit Lücke und bekannter Lösung). Ergänze Lösungen unter „Listen“ oder wähle einen anderen Modus.', 'error');
            return;
        }
        roundQueue = ['translate'];
    }
    mistakeCount = 0;
    answeredCount = 0;
    setStatus('');
    nextRound('');
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

function showQuestion(notice = '') {
    isShowingResolution = false;
    const item = activeList[currentIndex];
    const input = $('user-input');
    const sentenceBox = $('sentence-box');
    const n = LANGS[currentLang].name;
    const titles = { translate: `Deutsch ➔ ${n}`, reverse: `${n} ➔ Deutsch`, gap: 'Lückentext' };

    input.value = '';
    input.readOnly = false;
    $('feedback-display').className = 'feedback';
    $('feedback-display').textContent = notice;
    $('action-btn').textContent = 'Antwort prüfen';
    $('stats-display').textContent = `Vokabel ${currentIndex + 1} von ${activeList.length}`;
    $('phase-title').textContent = (isRetry ? 'Fehler-Wiederholung: ' : '') + titles[mode];
    sentenceBox.hidden = true;

    if (mode === 'translate') {
        $('question-display').textContent = item.de;
        input.placeholder = `${n}e Übersetzung...`.replace('Französische', 'Französische').replace('Englische', 'Englische');
    } else if (mode === 'reverse') {
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

    if (mode === 'reverse') {
        result = judgeDe(value, item);
        solution = item.de;
    } else if (mode === 'gap') {
        const info = gapInfo(item);
        result = judgeGap(value, info);
        if (!result && item.lang === 'en') result = judgeTerm(value, item);
        solution = info.answers.join('; ') + (item.lang === 'en' ? ` (${item.term})` : '');
    } else {
        result = judgeTerm(value, item);
    }

    answeredCount++;
    if (result) {
        item.ok++;
        feedback.className = 'feedback correct';
        if (result === 'typo') feedback.textContent = `Richtig (kleiner Tippfehler) 🎉 Schreibweise: ${solution}`;
        else if (result === 'accent') feedback.textContent = `Richtig, aber achte auf die Akzente: ${solution} 🎉`;
        else feedback.textContent = 'Richtig! 🎉';
    } else {
        item.bad++;
        mistakeCount++;
        feedback.className = 'feedback wrong';
        feedback.textContent = `Falsch ❌ Lösung: ${solution}`;
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
        return showQuestion(`Noch ${activeList.length} Wackelkandidaten, nochmal!`);
    }
    nextRound(roundQueue.length ? 'Super! Nächste Runde: Lückentext.' : '');
}

function finish() {
    $('end-text').textContent = `${answeredCount} Antworten, davon ${mistakeCount} Fehler. Du bist bereit für den Test! 🎉`;
    showScreen('end');
    $('restart-btn').focus();
}
function backToMain() {
    showScreen('main');
    showTab(currentTab);
}

/* ================= PWA ================= */
let installPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function setupPwa() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker fehlgeschlagen', err));
        });
    }
    const DISMISS_KEY = 'vokabeltrainer.installDismissed';
    const bar = $('install-bar');
    const btn = $('install-btn');
    const hint = $('ios-hint');
    let dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { /* egal */ }
    if (isStandalone() || dismissed) return;

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        installPrompt = e;
        hint.hidden = true;
        btn.hidden = false;
        bar.hidden = false;
    });
    window.addEventListener('appinstalled', () => { installPrompt = null; bar.hidden = true; });
    btn.addEventListener('click', async () => {
        if (!installPrompt) return;
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => {});
        installPrompt = null;
        bar.hidden = true;
    });
    $('install-dismiss').addEventListener('click', () => {
        bar.hidden = true;
        try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* egal */ }
    });
    if (isIos()) { btn.hidden = true; hint.hidden = false; bar.hidden = false; }
}

/* ================= Init ================= */
function init() {
    window.addEventListener('error', (ev) => {
        const msg = `❌ Skriptfehler: ${ev.message}`;
        if (!$('main-screen').hidden) setStatus(msg, 'error');
        else { const el = $('login-msg'); el.textContent = msg; el.hidden = false; }
    });

    // Login
    $('login-form').addEventListener('submit', (e) => { e.preventDefault(); authSubmit('login'); });
    $('register-btn').addEventListener('click', () => authSubmit('register'));
    $('guest-btn').addEventListener('click', () => enterAccount({ name: '', guest: true }));
    $('logout-btn').addEventListener('click', logout);

    // Sprache & Tabs
    document.querySelectorAll('.lang-btn').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

    // Üben
    $('sel-all').addEventListener('click', () => { deselected.clear(); renderLearn(); });
    $('sel-none').addEventListener('click', () => {
        langPool().forEach((v) => deselected.add(groupKey(v)));
        renderLearn();
    });
    const sel = $('mode-select');
    try { const m = localStorage.getItem(MODE_KEY); if (m && [...sel.options].some((o) => o.value === m)) sel.value = m; } catch (e) { /* egal */ }
    sel.addEventListener('change', () => { try { localStorage.setItem(MODE_KEY, sel.value); } catch (e) { /* egal */ } });
    $('start-btn').addEventListener('click', startSession);

    // Listen
    let searchTimer = null;
    $('list-search').addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { listQuery = e.target.value; renderLists(); }, 200);
    });
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
        if (vocabularyPool.some((v) => sameVocab(v, item))) { setStatus('ℹ️ Diese Vokabel gibt es schon.', 'busy'); return; }
        vocabularyPool.push(item);
        addConfirmed(`${term} ${de} ${sentence}`);
        rebuildProtected();
        savePool();
        refreshAll();
        $('manual-form').reset();
        $('m-term').focus();
        setStatus(`✅ „${term}“ hinzugefügt.`, 'ok');
    });

    // Trainer
    $('action-btn').addEventListener('click', checkAnswer);
    $('user-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); checkAnswer(); }
    });
    $('quit-btn').addEventListener('click', backToMain);
    $('restart-btn').addEventListener('click', startSession);
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
        enterAccount({ name: '', guest: true });
        return;
    }
    if (sb) {
        sb.auth.getSession().then(({ data }) => {
            const u = data && data.session && data.session.user;
            if (u) enterAccount({ id: u.id, name: (u.email || '').split('@')[0], guest: false });
        }).catch(() => { /* zum Login */ });
    }
}

setupPwa();
init();
