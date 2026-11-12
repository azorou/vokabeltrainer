'use strict';

/* ================= Konstanten & State ================= */
const USERS_KEY = 'vokabeltrainer.users.v1';
const SESSION_KEY = 'vokabeltrainer.session';
const MODE_KEY = 'vokabeltrainer.mode';
const OLD_POOL_KEY = 'vokabeltrainer.pool.v1';
const $ = (id) => document.getElementById(id);

let account = null;                  // { name, guest }
let vocabularyPool = [];             // { en, de, sentence, fix? }
const confirmedWords = new Set();    // vom Nutzer bestätigte Wörter: nie automatisch ändern
let protectedWords = new Set();      // alle Wörter aus Stichwörtern

let activeList = [];
let wrongAnswers = [];
let roundQueue = [];
let currentIndex = 0;
let mode = 'translate';              // 'translate' | 'gap' | 'reverse'
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
/** Antwort-Vergleich: ohne Satzzeichen */
const clean = (s) => norm(s).replace(/[.,;:!?"“”„()]/g, '').replace(/\s+/g, ' ').trim();
const letters = (s) => String(s).toLowerCase().match(/\p{L}+/gu) || [];
const stemOf = (w) => (w.length >= 4 && /[ey]$/.test(w) ? w.slice(0, -1) : w);

function setStatus(msg, type = 'busy') {
    const el = $('status-text');
    el.hidden = !msg;
    el.textContent = msg;
    el.style.color = { busy: '#b9770e', ok: '#1e8449', error: '#c0392b' }[type];
}
function showScreen(name) {
    ['login', 'scan', 'trainer', 'end'].forEach((n) => { $(`${n}-screen`).hidden = n !== name; });
}
const autofixOn = () => { const el = $('autofix'); return !el || el.checked; };

/* ================= Konten & Speicherung (Supabase) ================= */
const SUPABASE_URL = 'https://tjdgptcdlaaonuiogbzn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_3qPEGh16ss9PzCWpJjuAeQ_zxwTPupX';
const AUTH_DOMAIN = 'vokabeltrainer.app';   // nur für die interne Pseudo-E-Mail, es wird nie eine Mail versendet
const sb = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

let syncMeta = { base: null, dirty: false };   // base = Cloud-Zeitstempel, auf dem unsere Version aufbaut
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

function rebuildProtected() {
    protectedWords = new Set();
    vocabularyPool.forEach((v) => letters(v.en).forEach((w) => protectedWords.add(w)));
}
const isProtected = (w) => protectedWords.has(w) || confirmedWords.has(w);
const addConfirmed = (text) => letters(text).forEach((w) => confirmedWords.add(w));

function sanitizePool(arr) {
    return (Array.isArray(arr) ? arr : [])
        .filter((v) => v && v.en && v.de)
        .map((v) => ({ en: String(v.en), de: String(v.de), sentence: String(v.sentence || ''), fix: Array.isArray(v.fix) ? v.fix : undefined }));
}

/* ---- lokaler Zwischenspeicher (auch für Offline und Gast) ---- */
const dataKey = () => `vokabeltrainer.data.v2.${account.guest ? 'guest' : account.id}`;
const payload = () => ({ v: 1, pool: vocabularyPool, confirmed: [...confirmedWords] });

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

/* ---- Speichern ---- */
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
    renderList();
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
            if (res.error.code === '23505') outcome = 'conflict';     // Zeile existiert schon
            else throw res.error;
        } else if (!res.data || !res.data.length) {
            outcome = 'conflict';                                     // Zeitstempel hat sich geändert
        } else {
            syncMeta.base = res.data[0].updated_at;
            syncMeta.dirty = changeSeq !== seq;                       // währenddessen weiter bearbeitet?
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
                        if (!vocabularyPool.some((x) => norm(x.en) === norm(v.en))) vocabularyPool.push(v);
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
        renderList();
        await pushToCloud();
    }
}

/** Beim Anmelden und beim Zurückkehren in den Tab: Cloud-Stand prüfen */
async function syncOnLogin() {
    if (!sb || !account || account.guest || saving || syncBlocked) return;
    setSync('saving');
    try {
        const { data: row, error } = await sb.from('vocab_data').select('data, updated_at').eq('user_id', account.id).maybeSingle();
        if (error) throw error;
        if (!row) {                                   // Cloud noch leer
            syncMeta.base = null;
            if (vocabularyPool.length) { syncMeta.dirty = true; return pushToCloud(); }
            return setSync('saved');
        }
        if (row.updated_at === syncMeta.base) {       // gleicher Stand
            if (syncMeta.dirty) return pushToCloud();
            return setSync('saved');
        }
        if (!syncMeta.dirty) return applyRemote(row); // Cloud ist neuer, lokal nichts offen
        return resolveConflict();                     // beide geändert
    } catch (err) {
        console.warn('Cloud-Abgleich fehlgeschlagen', err);
        setSync('offline');
        if (syncMeta.dirty) saveTimer = setTimeout(pushToCloud, 15000);
    }
}

/* ---- Konto ---- */
async function enterAccount(acc) {
    account = acc;
    if (acc.guest) sessionStorage.setItem(SESSION_KEY, 'guest');
    else sessionStorage.removeItem(SESSION_KEY);
    loadLocal();
    $('account-name').textContent = acc.guest ? '👤 Gast (nur dieses Gerät)' : `👤 ${acc.name}`;
    $('account-bar').hidden = false;
    $('login-pass').value = '';
    setStatus('');
    setSync(acc.guest ? 'none' : (syncMeta.dirty ? 'dirty' : 'saved'));
    showScreen('scan');
    renderList();
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
    $('account-bar').hidden = true;
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
    const payload = { app: 'vokabeltrainer', v: 1, pool: vocabularyPool, confirmed: [...confirmedWords] };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
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
        const incoming = sanitizePool(data.pool);
        let added = 0;
        incoming.forEach((v) => {
            if (!vocabularyPool.some((x) => norm(x.en) === norm(v.en))) { vocabularyPool.push(v); added++; }
        });
        (data.confirmed || []).forEach((w) => confirmedWords.add(String(w)));
        rebuildProtected();
        savePool();
        renderList();
        setStatus(`✅ Sicherung geladen: ${added} neue Vokabeln.`, 'ok');
    } catch (e) {
        setStatus('❌ Die Datei konnte nicht gelesen werden.', 'error');
    }
}

/* ================= Wörterbuch ================= */
const DICT_SOURCES = {
    en: { local: 'woerter-en.json', pkg: 'an-array-of-english-words@2.0.0' },
    de: { local: 'woerter-de.json', pkg: 'an-array-of-german-words@1.2.0' }
};
const dicts = { en: null, de: null };
const CONFUSION_CONF = { en: 90, de: 85 };  // Verwechslungs-Korrektur nur unter dieser Erkennungssicherheit
const EDIT_CONF = { en: 70, de: -1 };       // Einzelbuchstaben-Korrektur: Deutsch aus (Liste zu lückenhaft)
const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
const SIMILAR = [['e', 'c'], ['a', 'o'], ['i', 'l'], ['u', 'v'], ['n', 'h'], ['t', 'f'], ['g', 'q'], ['b', 'h']];
const SKIP_WORDS = new Set(['sb', 'sth', 'etw', 'jmdn', 'jmd', 'jmdm', 'jdn', 'usw', 'bzw', 'fr', 'lat', 'pl', 'adj', 'adv']);
// Typische OCR-Verwechslungen: [steht im Text, richtig wäre]
const CONFUSIONS = [['m', 'rn'], ['rn', 'm'], ['w', 'vv'], ['vv', 'w'], ['d', 'cl'], ['cl', 'd'], ['h', 'li'], ['li', 'h']];
let dictPromise = null;

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
function ensureDicts() {
    if (!dictPromise) {
        dictPromise = Promise.all([loadDict('en'), loadDict('de')]).then(([en, de]) => {
            dicts.en = en;
            dicts.de = de;
            return { en: !!en, de: !!de };
        });
    }
    return dictPromise;
}

/** Bekannt = im Wörterbuch, auch mit gängiger Endung */
function isKnown(w, lang) {
    const d = dicts[lang];
    if (!d) return true;                       // ohne Wörterbuch nie "unbekannt" behaupten
    if (d.has(w)) return true;
    const suffixes = lang === 'en'
        ? ['s', 'es', 'd', 'ed', 'ing', 'ly', 'er', 'est', 'ness']
        : ['e', 'en', 'er', 'es', 'em', 'n', 's', 't', 'te', 'st', 'ten', 'et'];
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

const isSimilar = (a, b) => SIMILAR.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
function edits1(w) {
    const out = new Map();
    const add = (c, s) => { if (!out.has(c) || out.get(c) > s) out.set(c, s); };
    for (let i = 0; i <= w.length; i++) {
        if (i < w.length) {
            add(w.slice(0, i) + w.slice(i + 1), 1);
            for (const ch of ALPHA) if (ch !== w[i]) add(w.slice(0, i) + ch + w.slice(i + 1), isSimilar(ch, w[i]) ? 0 : 1);
        }
        for (const ch of ALPHA) add(w.slice(0, i) + ch + w.slice(i), 1);
        if (i < w.length - 1) add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2), 1);
    }
    out.delete(w);
    return out;
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
    // 2) Einzelbuchstaben-Fehler, nur bei sehr unsicherer Erkennung
    if (lang === 'en' && w.length >= 5 && conf < EDIT_CONF[lang]) {
        const cands = [...edits1(w)].filter(([c]) => d.has(c));
        if (!cands.length) return null;
        const min = Math.min(...cands.map(([, s]) => s));
        const best = cands.filter(([, s]) => s === min);
        return best.length === 1 ? best[0][0] : null;
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

/* ================= Kontext: Satz an Stichwort anpassen ================= */
function adaptSentence(e, sentConf, notes) {
    const base = norm(e.en).split(' ')[0];
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

function refineEntry(e, confs) {
    const notes = [];
    const labels = { en: 'Englisch', de: 'Deutsch', sentence: 'Satz' };
    // Zeichenverwechslungen mitten im Wort (0→o, 1/|→l, großes I→l)
    const fixChars = (s) => s
        .replace(/(\p{L})0(?=\p{L})/gu, '$1o')
        .replace(/(\p{L})[1|](?=\p{L})/gu, '$1l')
        .replace(/(\p{Ll})I(?=\p{Ll})/gu, '$1l');
    for (const key of ['en', 'de', 'sentence']) {
        const fixed = fixChars(e[key]);
        if (fixed !== e[key]) { notes.push(`${labels[key]}: „${e[key]}“ → „${fixed}“`); e[key] = fixed; }
    }
    if (autofixOn()) {
        letters(e.en).forEach((w) => protectedWords.add(w));       // Stichwort ist maßgeblich
        adaptSentence(e, confs.sent, notes);
        const stem = stemOf(norm(e.en).split(' ')[0]);
        e.de = dictCorrect(e.de, 'de', confs.de, 'Deutsch', notes, false, '');
        e.sentence = dictCorrect(e.sentence, 'en', confs.sent, 'Satz', notes, true, stem);
    }
    if (notes.length) e.fix = notes;
    return e;
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
        on[y] = c > w * 0.45;                     // lange grüne Linie quer über die Seite
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
    const margin = Math.round(w * 0.012);         // Überstand der grünen Überschrift
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

/** Skaliert kleine Screenshots hoch und entfernt grüne Kästen */
async function prepareImage(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(4, Math.max(1, 2000 / bmp.width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const boxes = maskGreenBoxes(ctx, canvas.width, canvas.height);
    return { canvas, boxes };
}

async function handleBatchUpload(files) {
    files = [...files].filter((f) => f.type.startsWith('image/'));
    if (!files.length || isScanning) return;
    if (typeof Tesseract === 'undefined') {
        setStatus('❌ Texterkennung konnte nicht geladen werden (Internet / Script-URL prüfen).', 'error');
        return;
    }

    isScanning = true;
    showPreviews(files);
    let dictState = { en: false, de: false };
    if (autofixOn()) {
        setStatus('⏳ Lade Wörterbücher (einmalig, ca. 3–5 MB)…');
        dictState = await ensureDicts();
    }
    setStatus('⏳ Initialisiere Texterkennung…');

    let currentImg = 0;
    let failed = 0;
    let added = 0;
    let boxes = 0;
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
                const prep = await prepareImage(files[i]);
                boxes += prep.boxes;
                const { data } = await worker.recognize(prep.canvas);
                added += addEntries(parseTable(data.words || []));
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
    const dictNote = autofixOn() && !(dictState.en && dictState.de) ? ' – Wörterbuch nicht vollständig geladen, Korrektur eingeschränkt' : '';
    if (added) {
        setStatus(`✅ ${added} neue Vokabeln erkannt (gesamt ${vocabularyPool.length})${boxes ? `, ${boxes} grüne(r) Kasten entfernt` : ''}${failed ? `, ${failed} Bild(er) fehlgeschlagen` : ''}${dictNote}. Bitte kurz kontrollieren.`, 'ok');
    } else {
        setStatus('❌ Keine neuen Vokabeln erkannt. Bitte Screenshot mit 3 gut lesbaren Spalten verwenden.', 'error');
    }
}

function addEntries(entries) {
    let added = 0;
    entries.forEach((e) => {
        if (!vocabularyPool.some((v) => norm(v.en) === norm(e.en))) { vocabularyPool.push(e); added++; }
    });
    rebuildProtected();
    savePool();
    renderList();
    return added;
}

/* ================= Tabellen-Parser (3 Spalten) ================= */
const PHON_CHARS = /[ˈˌːəɪʊɒʌæðθʃʒŋɑɔɜɛɡ]/;
const ARROW_RE = /[→↔⇒⇔⟶⟷]|<\s*[-–—=]{1,3}\s*>|<\s*>|[-–—=]{1,3}\s*>|<\s*[-–—=]{1,3}/;

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

/** Stichwort ohne Lautschrift: bei erstem Klammer-/Lautschrift-Token wird abgeschnitten */
function parseHeadword(raw) {
    const tokens = raw.replace(/^[\s\d*.]+/, '').split(/\s+/).filter(Boolean);
    const kept = [];
    for (const tok of tokens) {
        if (/^[\[\(\{|,;'’ˈˌ]/.test(tok) || /\]$/.test(tok) || PHON_CHARS.test(tok) || /\w:|:\w/.test(tok)) break;
        kept.push(tok.replace(/,$/, ''));
        if (/,$/.test(tok)) break;
    }
    return kept.join(' ').replace(/[^\p{L}\s/.'’-]/gu, '').trim();
}

function joinHyphenated(lines) {
    let out = '';
    for (const l of lines) {
        out = out.endsWith('-') ? out.slice(0, -1) + l : out + (out ? ' ' : '') + l;
    }
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
function extractSentence(lines) {
    const out = [];
    for (const l of lines) {
        if (/^(Fr|Lat)\.?\s/i.test(l) || ARROW_RE.test(l)) break;
        if (out.length && /\s=\s/.test(l)) break;
        out.push(l);
    }
    return fixPunct(joinHyphenated(out));
}

function parseTable(rawWords) {
    const words = rawWords
        .map((w) => ({ t: (w.text || '').trim(), c: w.confidence, x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1 }))
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
        const de = fixPunct(joinHyphenated(collect(l2, row)).replace(/[|!•]/g, ''));
        const sentence = extractSentence(collect(l3, row)).replace(/\|/g, 'I');
        if (/^[A-Za-z]/.test(en) && en.split(' ').length <= 6 && de.length > 1 && sentence.length > 5) {
            const inRow = (arr) => arr.filter((w) => w.yc >= row.top && w.yc < row.end);
            const confMap = (arr) => {
                const m = {};
                inRow(arr).forEach((w) => {
                    const k = w.t.toLowerCase().replace(/[^\p{L}]/gu, '');
                    if (k) m[k] = Math.min(m[k] ?? 100, w.c ?? 100);
                });
                return m;
            };
            const confs = { en: confMap(cols[0]), de: confMap(cols[1]), sent: confMap(cols[2]) };
            entries.push(refineEntry({ en, de, sentence }, confs));
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
        input.addEventListener('change', () => { addConfirmed(input.value); rebuildProtected(); savePool(); });
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
            rebuildProtected();
            savePool();
            renderList();
        });
        row.append(
            makeInput(item, 'en', 'Englisch'),
            makeInput(item, 'de', 'Deutsch'),
            del,
            makeInput(item, 'sentence', 'Beispielsatz', 'full')
        );
        if (item.fix && item.fix.length) {
            const note = document.createElement('div');
            note.className = 'fix-note';
            note.textContent = `✎ Automatisch korrigiert: ${item.fix.join(' · ')}`;
            row.append(note);
        }
        box.append(row);
    });

    const n = vocabularyPool.length;
    $('scanned-title').textContent = `Vokabeln (${n})`;
    $('scanned-box').hidden = n === 0;
    $('quiz-setup').hidden = n === 0;
    $('export-btn').hidden = n === 0;
    $('clear-btn').hidden = n === 0;
}

/* ================= Prüflogik ================= */
/** Lückentext: ersetzt das (auch gebeugte) Lernwort im Satz */
function makeGap(item) {
    if (!item.sentence) return null;
    const base = norm(item.en).split(' ')[0];
    if (!base || base.length < 2) return null;
    const stem = stemOf(base);
    const src = `\\b${escapeRe(stem)}\\p{L}*`;
    const m = item.sentence.match(new RegExp(src, 'iu'));
    if (!m) return null;
    return { text: item.sentence.replace(new RegExp(src, 'giu'), '_____'), match: m[0].toLowerCase() };
}

function judge(answer, item, extraTargets = []) {
    const a = clean(answer);
    if (!a) return null;
    const full = clean(item.en);
    const targets = [full, full.split(' ')[0], ...extraTargets.map(clean)];
    if (targets.includes(a)) return 'exact';
    if (targets.some((t) => t.length >= 5 && levenshtein(a, t) <= 1)) return 'typo';
    return null;
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
    if ([...targets].some((t) => t.length >= 5 && levenshtein(a, t) <= 1)) return 'typo';
    return null;
}

/* ================= Trainer ================= */
function startSession() {
    if (!vocabularyPool.length) return;
    const sel = $('mode-select').value;
    roundQueue = sel === 'both' ? ['translate', 'gap'] : [sel];
    if (roundQueue.includes('gap') && !vocabularyPool.some((v) => makeGap(v))) {
        if (sel === 'gap') {
            setStatus('❌ Kein Eintrag hat einen Beispielsatz, der das Wort enthält. Bitte Sätze ergänzen oder anderen Modus wählen.', 'error');
            return;
        }
        roundQueue = ['translate'];
    }
    mistakeCount = 0;
    answeredCount = 0;
    nextRound('');
}

function nextRound(notice) {
    while (roundQueue.length) {
        mode = roundQueue.shift();
        const items = vocabularyPool.filter((v) => mode !== 'gap' || makeGap(v));
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
    const titles = { translate: 'Deutsch ➔ Englisch', reverse: 'Englisch ➔ Deutsch', gap: 'Lückentext' };

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
        input.placeholder = 'Englische Übersetzung...';
    } else if (mode === 'reverse') {
        $('question-display').textContent = item.en;
        input.placeholder = 'Deutsche Übersetzung...';
    } else {
        // Lückentext: bewusst ohne Hinweis
        $('question-display').textContent = 'Ergänze das fehlende Wort:';
        input.placeholder = 'Fehlendes Wort...';
        sentenceBox.textContent = makeGap(item).text;
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
    let solution = item.en;

    if (mode === 'reverse') {
        result = judgeDe(value, item);
        solution = item.de;
    } else {
        const gap = mode === 'gap' ? makeGap(item) : null;
        result = judge(value, item, gap ? [gap.match] : []);
        if (gap && gap.match !== norm(item.en)) solution = `${gap.match} (${item.en})`;
    }

    answeredCount++;
    if (result) {
        feedback.className = 'feedback correct';
        feedback.textContent = result === 'typo' ? `Richtig (kleiner Tippfehler) 🎉 Schreibweise: ${solution}` : 'Richtig! 🎉';
    } else {
        mistakeCount++;
        feedback.className = 'feedback wrong';
        feedback.textContent = `Falsch ❌ Lösung: ${solution}`;
        if (!wrongAnswers.includes(item)) wrongAnswers.push(item);
    }

    if (item.sentence) {
        $('sentence-box').textContent = item.sentence;
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

function backToList() {
    showScreen('scan');
    renderList();
}

/* ================= Init ================= */
function init() {
    window.addEventListener('error', (ev) => {
        const msg = `❌ Skriptfehler: ${ev.message}`;
        if (!$('scan-screen').hidden) setStatus(msg, 'error');
        else { const el = $('login-msg'); el.textContent = msg; el.hidden = false; }
    });

    // Login
    $('login-form').addEventListener('submit', (e) => { e.preventDefault(); authSubmit('login'); });
    $('register-btn').addEventListener('click', () => authSubmit('register'));
    $('guest-btn').addEventListener('click', () => enterAccount({ name: '', guest: true }));
    $('logout-btn').addEventListener('click', logout);

    // Upload
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

    // Manuelle Eingabe
    $('manual-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const en = $('m-en').value.trim();
        const de = $('m-de').value.trim();
        const sentence = $('m-sent').value.trim();
        if (!en || !de) return;
        if (vocabularyPool.some((v) => norm(v.en) === norm(en))) {
            setStatus('ℹ️ Diese Vokabel gibt es schon.', 'busy');
            return;
        }
        vocabularyPool.push({ en, de, sentence });
        addConfirmed(`${en} ${de} ${sentence}`);
        rebuildProtected();
        savePool();
        renderList();
        $('manual-form').reset();
        $('m-en').focus();
        setStatus(`✅ „${en}“ hinzugefügt.`, 'ok');
    });

    // Sicherung & Liste leeren (zweistufig)
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
            clearTimer = setTimeout(() => { clearTimer = null; btn.textContent = '🗑 Liste leeren'; }, 4000);
            return;
        }
        clearTimeout(clearTimer);
        clearTimer = null;
        btn.textContent = '🗑 Liste leeren';
        vocabularyPool = [];
        rebuildProtected();
        savePool();
        renderList();
        setStatus('Liste geleert.', 'ok');
    });

    // Modus-Menü
    const sel = $('mode-select');
    try { const m = localStorage.getItem(MODE_KEY); if (m && [...sel.options].some((o) => o.value === m)) sel.value = m; } catch (e) { /* egal */ }
    sel.addEventListener('change', () => { try { localStorage.setItem(MODE_KEY, sel.value); } catch (e) { /* egal */ } });

    // Trainer
    $('start-btn').addEventListener('click', startSession);
    $('action-btn').addEventListener('click', checkAnswer);
    $('user-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); checkAnswer(); }
    });
    $('quit-btn').addEventListener('click', backToList);
    $('restart-btn').addEventListener('click', startSession);
    $('back-btn').addEventListener('click', backToList);

    // Sitzung wiederherstellen
    try {
        const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
        if (s && (s.guest || s.name)) return enterAccount({ name: s.name || '', guest: !!s.guest });
    } catch (e) { /* zum Login */ }
    showScreen('login');
}

init();
