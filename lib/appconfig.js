'use strict';

// Darstellungs-Konfiguration der Web-App (Ausblenden, Umbenennen, Sortieren,
// Favoriten, Farben ...). Wird als JSON im State "webconfig" gespeichert und
// von der App über PUT /api/config geändert. Alle Eingaben werden strikt
// geprüft und auf bekannte Felder reduziert.

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ENTRIES = 500;
const MAX_KEY = 160;
const MAX_NAME = 60;
const MAX_ICON = 8;

const TILE_KEYS = ['alarm', 'windows', 'motion', 'lights', 'blinds'];
const LIST_KEYS = ['windows', 'motion', 'lights', 'temps', 'favorites'];

function defaults() {
    const tiles = Object.create(null);
    TILE_KEYS.forEach(k => { tiles[k] = true; });
    const lists = Object.create(null);
    LIST_KEYS.forEach(k => { lists[k] = true; });
    return {
        version: 1,
        title: '',
        theme: 'auto',
        accent: '',
        density: 'normal',
        showOverview: true,
        overview: { tiles, lists },
        floors: Object.create(null),
        rooms: Object.create(null),
        devices: Object.create(null)
    };
}

function fail(msg) {
    return Object.assign(new Error(msg), { status: 400 });
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cleanString(v, max, what) {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw fail(`${what}: Text erwartet`);
    const s = v.trim();
    if (s.length > max) throw fail(`${what}: maximal ${max} Zeichen`);
    return s;
}

function cleanBool(v, def) {
    if (v === undefined) return def;
    if (typeof v !== 'boolean') throw fail('Ja/Nein-Wert erwartet');
    return v;
}

function cleanFlags(src, keys, what) {
    const out = Object.create(null);
    const s = src === undefined ? {} : src;
    if (!isPlainObject(s)) throw fail(`${what}: Objekt erwartet`);
    for (const k of keys) out[k] = cleanBool(s[k], true);
    return out;
}

function cleanEntries(src, what, allowFavorite) {
    const out = Object.create(null);
    if (src === undefined) return out;
    if (!isPlainObject(src)) throw fail(`${what}: Objekt erwartet`);
    const entries = Object.entries(src);
    if (entries.length > MAX_ENTRIES) throw fail(`${what}: zu viele Einträge`);
    for (const [key, val] of entries) {
        if (key.length === 0 || key.length > MAX_KEY || FORBIDDEN_KEYS.has(key)) throw fail(`${what}: ungültiger Schlüssel`);
        if (!isPlainObject(val)) throw fail(`${what}: ungültiger Eintrag`);
        const e = {};
        if (cleanBool(val.hidden, false)) e.hidden = true;
        const name = cleanString(val.name, MAX_NAME, 'Name');
        if (name) e.name = name;
        if (val.order !== undefined) {
            if (!Number.isInteger(val.order) || val.order < 0 || val.order > 9999) throw fail('Reihenfolge ungültig');
            e.order = val.order;
        }
        const icon = cleanString(val.icon, MAX_ICON, 'Symbol');
        if (icon) e.icon = icon;
        if (allowFavorite && cleanBool(val.favorite, false)) e.favorite = true;
        if (Object.keys(e).length) out[key] = e;
    }
    return out;
}

function sanitize(raw) {
    if (!isPlainObject(raw)) throw fail('Ungültige Konfiguration');
    const cfg = defaults();

    cfg.title = cleanString(raw.title, 40, 'Titel');

    if (raw.theme !== undefined) {
        if (!['auto', 'light', 'dark'].includes(raw.theme)) throw fail('Ungültiges Farbschema');
        cfg.theme = raw.theme;
    }
    if (raw.accent !== undefined && raw.accent !== '') {
        if (typeof raw.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw.accent)) throw fail('Ungültige Akzentfarbe');
        cfg.accent = raw.accent.toLowerCase();
    }
    if (raw.density !== undefined) {
        if (!['normal', 'compact'].includes(raw.density)) throw fail('Ungültige Dichte');
        cfg.density = raw.density;
    }
    cfg.showOverview = cleanBool(raw.showOverview, true);

    const ov = raw.overview === undefined ? {} : raw.overview;
    if (!isPlainObject(ov)) throw fail('Übersicht: Objekt erwartet');
    cfg.overview = { tiles: cleanFlags(ov.tiles, TILE_KEYS, 'Kacheln'), lists: cleanFlags(ov.lists, LIST_KEYS, 'Listen') };

    cfg.floors = cleanEntries(raw.floors, 'Etagen', false);
    cfg.rooms = cleanEntries(raw.rooms, 'Räume', false);
    cfg.devices = cleanEntries(raw.devices, 'Geräte', true);
    return cfg;
}

// Gespeicherten Text laden; bei kaputten Daten Standardwerte verwenden
function parseStored(text) {
    if (!text || typeof text !== 'string') return defaults();
    try {
        return sanitize(JSON.parse(text));
    } catch (e) {
        return defaults();
    }
}

module.exports = { sanitize, defaults, parseStored };
