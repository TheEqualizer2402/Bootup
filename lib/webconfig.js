'use strict';

// Darstellung der Web-App (Sichtbarkeit, Namen, Reihenfolge, Design).
// Die Konfiguration kommt von außen (Web-App) und wird deshalb bei jedem
// Speichern komplett neu aufgebaut: nur bekannte Felder, begrenzte Längen,
// keine gefährlichen Schlüssel.

const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const THEMES = ['auto', 'light', 'dark'];
const DENSITIES = ['normal', 'compact'];
const TILE_KEYS = ['alarm', 'windows', 'motion', 'lights'];
const LIST_KEYS = ['windows', 'motion', 'lights', 'blinds', 'temps'];

const MAX_ENTRIES = 600;
const MAX_KEY = 120;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function str(v, max) {
    if (typeof v !== 'string') return '';
    // Steuerzeichen entfernen, Länge begrenzen
    return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function key(k) {
    if (typeof k !== 'string' || !k || k.length > MAX_KEY || BANNED_KEYS.has(k)) return null;
    return k;
}

function bool(v, def) {
    return typeof v === 'boolean' ? v : def;
}

function entries(obj) {
    return isObj(obj) ? Object.entries(obj).slice(0, MAX_ENTRIES) : [];
}

function keyList(arr) {
    const out = [];
    if (!Array.isArray(arr)) return out;
    for (const k of arr.slice(0, MAX_ENTRIES)) {
        const kk = key(k);
        if (kk && !out.includes(kk)) out.push(kk);
    }
    return out;
}

// Name/Ausblenden für Etagen und Räume
function nameHidden(v) {
    if (!isObj(v)) return null;
    const out = {};
    const name = str(v.name, 40);
    if (name) out.name = name;
    if (v.hidden === true) out.hidden = true;
    return Object.keys(out).length ? out : null;
}

function defaults() {
    const tiles = {};
    TILE_KEYS.forEach(k => { tiles[k] = true; });
    const lists = {};
    LIST_KEYS.forEach(k => { lists[k] = true; });
    return {
        title: '',
        theme: 'auto',
        accent: '',
        density: 'normal',
        showOverview: true,
        showFavorites: true,
        tiles,
        lists,
        floors: {},
        rooms: {},
        devices: {},
        order: { floors: [], rooms: {}, devices: {} }
    };
}

function sanitizeConfig(input) {
    const cfg = defaults();
    if (!isObj(input)) return cfg;

    cfg.title = str(input.title, 40);
    if (THEMES.includes(input.theme)) cfg.theme = input.theme;
    if (typeof input.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.accent)) cfg.accent = input.accent.toLowerCase();
    if (DENSITIES.includes(input.density)) cfg.density = input.density;
    cfg.showOverview = bool(input.showOverview, true);
    cfg.showFavorites = bool(input.showFavorites, true);

    if (isObj(input.tiles)) TILE_KEYS.forEach(k => { cfg.tiles[k] = bool(input.tiles[k], true); });
    if (isObj(input.lists)) LIST_KEYS.forEach(k => { cfg.lists[k] = bool(input.lists[k], true); });

    for (const [k, v] of entries(input.floors)) {
        const kk = key(k); const nh = nameHidden(v);
        if (kk && nh) cfg.floors[kk] = nh;
    }

    for (const [fk, rooms] of entries(input.rooms)) {
        const fkk = key(fk);
        if (!fkk || !isObj(rooms)) continue;
        const out = {};
        for (const [rk, v] of entries(rooms)) {
            const rkk = key(rk); const nh = nameHidden(v);
            if (rkk && nh) out[rkk] = nh;
        }
        if (Object.keys(out).length) cfg.rooms[fkk] = out;
    }

    for (const [id, v] of entries(input.devices)) {
        const kk = key(id);
        if (!kk || !isObj(v)) continue;
        const out = {};
        const name = str(v.name, 40);
        if (name) out.name = name;
        if (v.hidden === true) out.hidden = true;
        if (v.favorite === true) out.favorite = true;
        const icon = str(v.icon, 8);
        if (icon) out.icon = icon;
        if (Object.keys(out).length) cfg.devices[kk] = out;
    }

    if (isObj(input.order)) {
        cfg.order.floors = keyList(input.order.floors);
        for (const [fk, list] of entries(input.order.rooms)) {
            const fkk = key(fk); const l = keyList(list);
            if (fkk && l.length) cfg.order.rooms[fkk] = l;
        }
        for (const [fk, rooms] of entries(input.order.devices)) {
            const fkk = key(fk);
            if (!fkk || !isObj(rooms)) continue;
            const out = {};
            for (const [rk, list] of entries(rooms)) {
                const rkk = key(rk); const l = keyList(list);
                if (rkk && l.length) out[rkk] = l;
            }
            if (Object.keys(out).length) cfg.order.devices[fkk] = out;
        }
    }

    return cfg;
}

module.exports = { sanitizeConfig, defaults };
