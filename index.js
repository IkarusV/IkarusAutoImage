// ==========================================================================
// IkarusAutoImage — SillyTavern Extension
// Auto-image generation with presets, replacements (with children hierarchy),
// filters (remove/append/replace), double cleaner, and auto-cleaner.
// Uses SillyTavern's native /sd command for generation.
// ==========================================================================

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
} from '../../../../script.js';
import { appendMediaToMessage } from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

// ==========================================================================
// Constants
// ==========================================================================
const EXT = 'IkarusAutoImage';
const EXT_PATH = `/scripts/extensions/third-party/${EXT}`;

const INSERT_TYPE = { DISABLED: 'disabled', INLINE: 'inline', NEW_MESSAGE: 'new', REPLACE: 'replace' };

const DEFAULT_PROMPT = `<image_generation>
You must insert a <pic prompt="example prompt"> at end of the reply. Prompts are used for stable diffusion image generation, based on the plot and character to output appropriate prompts to generate captivating images.
</image_generation>`;

const DEFAULT_REGEX = '/\\[pic[^\\]]*?prompt="([^"]*)"[^\\]]*?\\]/g';

const DEFAULT_SETTINGS = {
    insertType: INSERT_TYPE.DISABLED,
    promptInjection: { enabled: true, prompt: DEFAULT_PROMPT, regex: DEFAULT_REGEX, position: 'deep_system', depth: 0 },
    presets: [],
    activePresetId: '', // currently selected preset ID
    // Per-character prompt: keyed by charId → string
    charPrompts: {},
    // Replacements: {id, name, scope, charId, trigger, matchMode, replacement, replaceMode, priority, parentId, enabled, folder}
    replacements: [],
    repFolders: [], // folder names for organizing global replacements
    repCategories: [], // category names (parent of folders)
    folderCategories: {}, // mapping: folder name → category name
    // Filters: {id, name, scope, charId, trigger, matchMode, action, actionText, findText, target, enabled}
    filters: [],
    invertProcessingOrder: false, // false = replacements first, true = filters first
    // Double cleaner: strips duplicate tags after all processing
    doubleCleaner: { mode: 'none', tags: '' }, // mode: 'none' | 'all' | 'listed'
    autoClean: false,
};

// ==========================================================================
// Helpers
// ==========================================================================
let _nextId = Date.now();
function uid() { return `ik_${_nextId++}_${Math.random().toString(36).slice(2, 8)}`; }
function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function s() { return extension_settings[EXT] || DEFAULT_SETTINGS; }
function getCurrentCharId() {
    try {
        const c = getContext();
        if (c.groupId) return `group_${c.groupId}`;
        if (c.characterId != null && c.characters?.[c.characterId]) {
            // Use avatar filename as stable key (e.g. "judy_hopps.png")
            const avatar = c.characters[c.characterId].avatar;
            if (avatar) return `avatar_${avatar}`;
        }
    } catch { }
    return null;
}
function getCurrentCharName() {
    try { const c = getContext(); if (c.name2) return c.name2; } catch { }
    return 'Unknown';
}

// Migrate old numeric char IDs to stable avatar-based IDs
function migrateCharKeys() {
    try {
        const es = s();
        const ctx = getContext();
        if (!ctx.characters?.length) return;
        let migrated = 0;

        // Build mapping: old key "char_N" → new key "avatar_filename.png"
        const keyMap = {};
        for (let i = 0; i < ctx.characters.length; i++) {
            const av = ctx.characters[i]?.avatar;
            if (av) keyMap[`char_${i}`] = `avatar_${av}`;
        }

        // Migrate charPrompts
        if (es.charPrompts) {
            for (const [oldKey, newKey] of Object.entries(keyMap)) {
                if (es.charPrompts[oldKey] && !es.charPrompts[newKey]) {
                    es.charPrompts[newKey] = es.charPrompts[oldKey];
                    delete es.charPrompts[oldKey];
                    migrated++;
                }
            }
        }

        // Migrate replacements
        if (es.replacements) {
            for (const r of es.replacements) {
                if (r.charId && keyMap[r.charId]) { r.charId = keyMap[r.charId]; migrated++; }
            }
        }

        // Migrate filters
        if (es.filters) {
            for (const f of es.filters) {
                if (f.charId && keyMap[f.charId]) { f.charId = keyMap[f.charId]; migrated++; }
            }
        }

        if (migrated > 0) {
            saveSettingsDebounced();
            console.log(`[${EXT}] Migrated ${migrated} character key(s) from numeric to avatar-based IDs`);
        }
    } catch (e) { console.error(`[${EXT}] Migration error:`, e); }
}
function escRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ==========================================================================
// Settings Lifecycle
// ==========================================================================
function ensureSettings() {
    extension_settings[EXT] = extension_settings[EXT] || {};
    const es = extension_settings[EXT];
    if (!es.insertType) es.insertType = DEFAULT_SETTINGS.insertType;
    if (!es.promptInjection) es.promptInjection = { ...DEFAULT_SETTINGS.promptInjection };
    else { for (const k of Object.keys(DEFAULT_SETTINGS.promptInjection)) { if (es.promptInjection[k] === undefined) es.promptInjection[k] = DEFAULT_SETTINGS.promptInjection[k]; } }
    if (!Array.isArray(es.presets)) es.presets = [];
    if (es.activePresetId === undefined) es.activePresetId = '';
    if (!es.charPrompts || typeof es.charPrompts !== 'object') es.charPrompts = {};
    if (!Array.isArray(es.replacements)) es.replacements = [];
    if (!Array.isArray(es.repFolders)) es.repFolders = [];
    if (!Array.isArray(es.repCategories)) es.repCategories = [];
    if (!es.folderCategories || typeof es.folderCategories !== 'object') es.folderCategories = {};
    // Ensure each replacement has a folder field
    for (const r of (es.replacements || [])) { if (r.folder === undefined) r.folder = ''; }
    if (!Array.isArray(es.filters)) es.filters = [];
    if (es.invertProcessingOrder === undefined) es.invertProcessingOrder = false;
    if (!es.doubleCleaner) es.doubleCleaner = { ...DEFAULT_SETTINGS.doubleCleaner };
    if (es.autoClean === undefined) es.autoClean = false;
}

function updateUI() {
    const es = s();
    $('#ikarus_auto_image_btn').toggleClass('selected', es.insertType !== INSERT_TYPE.DISABLED);
    if ($('#ikarus_insert_type').length) {
        $('#ikarus_insert_type').val(es.insertType);
        $('#ikarus_prompt_injection_enabled').prop('checked', es.promptInjection.enabled);
        $('#ikarus_prompt_text').val(es.promptInjection.prompt);
        $('#ikarus_prompt_regex').val(es.promptInjection.regex);
        $('#ikarus_prompt_position').val(es.promptInjection.position);
        $('#ikarus_prompt_depth').val(es.promptInjection.depth);
        $('#ikarus_invert_order').prop('checked', es.invertProcessingOrder);
        $('#ikarus_auto_clean').prop('checked', es.autoClean);
        $('#ikarus_dc_mode').val(es.doubleCleaner?.mode || 'none');
        $('#ikarus_dc_tags').val(es.doubleCleaner?.tags || '');
        $('#ikarus_dc_tags_row').toggle(es.doubleCleaner?.mode === 'listed');
    }
    renderPresetDropdown();
    loadCharPrompt();
    renderReplacementList();
    renderFilterList();
}

// ==========================================================================
// Preset System
// ==========================================================================
function renderPresetDropdown() {
    const sel = $('#ikarus_preset_select');
    if (!sel.length) return;
    sel.html('<option value="">-- Default --</option>' +
        (s().presets || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''));
    // Re-select the active preset so the dropdown shows the right name
    const activeId = s().activePresetId || '';
    sel.val(activeId);
}
function savePreset() {
    const name = prompt('Preset name:');
    if (!name?.trim()) return;
    const es = s();
    const p = { id: uid(), name: name.trim(), prompt: es.promptInjection.prompt, regex: es.promptInjection.regex, position: es.promptInjection.position, depth: es.promptInjection.depth };
    es.presets.push(p);
    es.activePresetId = p.id;
    saveSettingsDebounced(); renderPresetDropdown();
    toastr.success(`Preset "${p.name}" saved`);
}
function loadPreset(pid) {
    const es = s();
    es.activePresetId = pid || '';
    if (!pid) { Object.assign(es.promptInjection, { prompt: DEFAULT_PROMPT, regex: DEFAULT_REGEX, position: 'deep_system', depth: 0 }); }
    else { const p = es.presets.find(x => x.id === pid); if (!p) return; Object.assign(es.promptInjection, { prompt: p.prompt, regex: p.regex, position: p.position, depth: p.depth }); toastr.info(`Loaded: ${p.name}`); }
    saveSettingsDebounced(); updateUI();
}
function deletePreset() {
    const es = s();
    const pid = es.activePresetId || $('#ikarus_preset_select').val();
    if (!pid) { toastr.warning('No preset selected'); return; }
    const idx = es.presets.findIndex(x => x.id === pid); if (idx < 0) return;
    const n = es.presets[idx].name; if (!confirm(`Delete "${n}"?`)) return;
    es.presets.splice(idx, 1); saveSettingsDebounced(); loadPreset(''); toastr.success(`"${n}" deleted`);
}

// ==========================================================================
// Character Prompt (per-card, 5 numbered slots)
// ==========================================================================
const CHAR_PROMPT_SLOTS = 5;

function getCharPromptData(charId) {
    if (!charId) return null;
    const es = s();
    let data = es.charPrompts[charId];
    // Migrate from old string format
    if (typeof data === 'string') {
        data = { slots: [data, '', '', '', ''], active: 0 };
        es.charPrompts[charId] = data;
    }
    if (!data || !Array.isArray(data.slots)) {
        data = { slots: ['', '', '', '', ''], active: 0 };
        es.charPrompts[charId] = data;
    }
    // Ensure 5 slots
    while (data.slots.length < CHAR_PROMPT_SLOTS) data.slots.push('');
    return data;
}

function loadCharPrompt() {
    const charId = getCurrentCharId();
    const textarea = $('#ikarus_char_prompt');
    const slotBtns = $('#ikarus_char_slots');
    if (!textarea.length) return;
    if (!charId) {
        textarea.val('').attr('placeholder', 'Select a character first...');
        $('#ikarus_char_prompt_label').text('\ud83d\udcdd Character Prompt (no character)');
        slotBtns.html('');
        return;
    }
    const charName = getCurrentCharName();
    const data = getCharPromptData(charId);
    const active = data.active || 0;
    textarea.val(data.slots[active] || '').attr('placeholder', `Slot ${active + 1} for ${charName}... (tags, style rules, character details)`);
    $('#ikarus_char_prompt_label').text(`\ud83d\udcdd Character Prompt \u2014 ${charName}`);
    // Render slot buttons
    let btns = '';
    for (let i = 0; i < CHAR_PROMPT_SLOTS; i++) {
        const hasContent = (data.slots[i] || '').trim().length > 0;
        btns += `<button class="ikarus-slot-btn ${i === active ? 'active' : ''} ${hasContent && i !== active ? 'has-content' : ''}" data-slot="${i}">${i + 1}</button>`;
    }
    slotBtns.html(btns);
}

function switchCharSlot(slotIndex) {
    const charId = getCurrentCharId();
    if (!charId) return;
    // Save current text first
    saveCharPrompt();
    // Switch
    const data = getCharPromptData(charId);
    data.active = slotIndex;
    saveSettingsDebounced();
    loadCharPrompt();
}

function saveCharPrompt() {
    const charId = getCurrentCharId();
    if (!charId) return;
    const data = getCharPromptData(charId);
    const active = data.active || 0;
    data.slots[active] = $('#ikarus_char_prompt').val() || '';
    saveSettingsDebounced();
}

function getCharPromptText() {
    const charId = getCurrentCharId();
    if (!charId) return '';
    const data = getCharPromptData(charId);
    if (!data) return '';
    return data.slots[data.active || 0] || '';
}

// ==========================================================================
// Scope helpers (shared)
// ==========================================================================
let currentRepScope = 'global';
let currentFltScope = 'global';

function itemsForScope(list, scope) {
    const cid = getCurrentCharId();
    return scope === 'char' && cid ? list.filter(r => r.scope === 'char' && r.charId === cid) : list.filter(r => r.scope === 'global');
}
function activeItems(list) {
    const cid = getCurrentCharId();
    return list.filter(r => r.enabled && (r.scope === 'global' || (r.scope === 'char' && r.charId === cid)));
}

// ==========================================================================
// Replacements — with children, AND/OR, priority
// ==========================================================================
function getParentReplacements(scope) {
    return itemsForScope(s().replacements || [], scope).filter(r => !r.parentId);
}
function getChildrenOf(parentId) {
    return (s().replacements || []).filter(r => r.parentId === parentId);
}

function renderReplacementList() {
    const container = $('#ikarus_replacement_list');
    if (!container.length) return;
    const parents = getParentReplacements(currentRepScope);
    if (!parents.length) { container.html(''); return; }

    let html = '';
    for (const p of parents) {
        html += renderRepCard(p, false);
        const children = getChildrenOf(p.id);
        for (const c of children) {
            html += renderRepCard(c, true);
        }
    }
    container.html(html);
}

function renderRepCard(r, isChild) {
    const indent = isChild ? 'style="margin-left:20px;border-left:3px solid var(--SmartThemeQuoteColor,#e0a0ff);"' : '';
    const prefix = isChild ? '↳ ' : '';
    const transferBtn = r.scope === 'global'
        ? `<button class="menu_button ikarus-transfer-item" title="Move to current character">📥</button>`
        : `<button class="menu_button ikarus-transfer-item" title="Move to global">📤</button>`;
    return `
    <div class="ikarus-card ${r.enabled ? '' : 'disabled'}" data-id="${esc(r.id)}" data-type="replacement" ${indent}>
        <div class="card-header">
            <span class="card-name">${prefix}${esc(r.name || 'Unnamed')}</span>
            <div class="card-actions">
                ${!isChild ? `<button class="menu_button ikarus-add-child" title="Add child">👶</button>` : ''}
                ${!isChild ? transferBtn : ''}
                <button class="menu_button ikarus-toggle-item" title="${r.enabled ? 'Disable' : 'Enable'}">${r.enabled ? '✅' : '⬜'}</button>
                <button class="menu_button ikarus-edit-item" title="Edit">✏️</button>
                <button class="menu_button ikarus-delete-item" title="Delete">🗑️</button>
            </div>
        </div>
        <div class="card-details">
            <div><b class="trigger-label">Find:</b> ${esc(r.trigger)} <em>(${r.matchMode || 'OR'})</em></div>
            <div><b class="replace-label">→</b> ${esc((r.replacement || '').substring(0, 100))}${(r.replacement || '').length > 100 ? '…' : ''}</div>
            <div>Mode: ${r.replaceMode === 'all' ? 'All' : 'First'} | P${r.priority || 0} | <span class="scope-badge">${r.scope === 'char' ? '👤' : '🌐'}</span>${r.folder ? ` | 📁 ${esc(r.folder)}` : ''}</div>
        </div>
    </div>`;
}

function addReplacement(parentId) {
    const name = $('#ikarus_rep_name').val()?.trim();
    const trigger = $('#ikarus_rep_trigger').val()?.trim();
    const replacement = $('#ikarus_rep_replacement').val()?.trim();
    const matchMode = $('#ikarus_rep_match').val() || 'OR';
    const replaceMode = $('#ikarus_rep_mode').val() || 'first';
    const priority = parseInt($('#ikarus_rep_priority').val()) || 0;

    if (!trigger) { toastr.warning('Trigger is required'); return; }
    if (!replacement) { toastr.warning('Replacement text is required'); return; }

    s().replacements.push({
        id: uid(), name: name || trigger, scope: currentRepScope,
        charId: currentRepScope === 'char' ? getCurrentCharId() : null,
        trigger, matchMode, replacement, replaceMode, priority,
        parentId: parentId || null, enabled: true,
    });
    saveSettingsDebounced(); renderReplacementList();
    $('#ikarus_rep_name, #ikarus_rep_trigger, #ikarus_rep_replacement').val('');
    $('#ikarus_rep_priority').val('0');
    toastr.success(`Replacement "${name || trigger}" added${parentId ? ' as child' : ''}`);
}

function editReplacement(id) {
    const es = s(); const r = es.replacements.find(x => x.id === id); if (!r) return;
    $('#ikarus_rep_name').val(r.name); $('#ikarus_rep_trigger').val(r.trigger);
    $('#ikarus_rep_replacement').val(r.replacement); $('#ikarus_rep_match').val(r.matchMode || 'OR');
    $('#ikarus_rep_mode').val(r.replaceMode || 'first'); $('#ikarus_rep_priority').val(r.priority || 0);
    // Store parentId for re-adding
    $('#ikarus_rep_add').data('parent-id', r.parentId || '');
    const idx = es.replacements.findIndex(x => x.id === id);
    if (idx >= 0) es.replacements.splice(idx, 1);
    saveSettingsDebounced(); renderReplacementList();
    toastr.info(`Editing "${r.name}" — modify and click Add`);
}

// ==========================================================================
// Filters — trigger-based with remove/append/replace actions
// ==========================================================================
function renderFilterList() {
    const container = $('#ikarus_filter_list');
    if (!container.length) return;
    const items = itemsForScope(s().filters || [], currentFltScope);
    if (!items.length) { container.html(''); return; }

    container.html(items.map(f => {
        const transferBtn = f.scope === 'global'
            ? `<button class="menu_button ikarus-transfer-item" title="Move to current character">📥</button>`
            : `<button class="menu_button ikarus-transfer-item" title="Move to global">📤</button>`;
        return `
        <div class="ikarus-card ${f.enabled ? '' : 'disabled'}" data-id="${esc(f.id)}" data-type="filter">
            <div class="card-header">
                <span class="card-name">${esc(f.name || 'Unnamed')}</span>
                <div class="card-actions">
                    ${transferBtn}
                    <button class="menu_button ikarus-toggle-item">${f.enabled ? '✅' : '⬜'}</button>
                    <button class="menu_button ikarus-edit-item" title="Edit">✏️</button>
                    <button class="menu_button ikarus-delete-item" title="Delete">🗑️</button>
                </div>
            </div>
            <div class="card-details">
                <div><b class="trigger-label">When:</b> ${esc(f.trigger)} <em>(${f.matchMode || 'OR'})</em></div>
                <div><b class="${f.action === 'remove' ? 'filter-label' : 'replace-label'}">${f.action === 'remove' ? '✂ Remove:' : f.action === 'append' ? '＋ Append:' : '⇄ Replace:'}</b> ${esc((f.actionText || f.findText || '').substring(0, 80))}</div>
                ${f.action === 'replace' ? `<div><b class="replace-label">→</b> ${esc((f.actionText || '').substring(0, 80))}</div>` : ''}
                <div>Target: ${f.target || 'positive'} | <span class="scope-badge">${f.scope === 'char' ? '👤' : '🌐'}</span></div>
            </div>
        </div>`;
    }).join(''));
}

function addFilter() {
    const name = $('#ikarus_flt_name').val()?.trim();
    const trigger = $('#ikarus_flt_trigger').val()?.trim();
    const matchMode = $('#ikarus_flt_match').val() || 'OR';
    const action = $('#ikarus_flt_action').val() || 'remove';
    const actionText = $('#ikarus_flt_action_text').val()?.trim();
    const findText = $('#ikarus_flt_find_text').val()?.trim();
    const target = $('#ikarus_flt_target').val() || 'positive';

    if (!trigger) { toastr.warning('Trigger is required'); return; }
    if (action === 'remove' && !actionText) { toastr.warning('Pattern to remove is required'); return; }
    if (action === 'append' && !actionText) { toastr.warning('Text to append is required'); return; }
    if (action === 'replace' && (!findText || !actionText)) { toastr.warning('Find and Replace text required'); return; }

    s().filters.push({
        id: uid(), name: name || trigger, scope: currentFltScope,
        charId: currentFltScope === 'char' ? getCurrentCharId() : null,
        trigger, matchMode, action, actionText: actionText || '', findText: findText || '', target, enabled: true,
    });
    saveSettingsDebounced(); renderFilterList();
    $('#ikarus_flt_name, #ikarus_flt_trigger, #ikarus_flt_action_text, #ikarus_flt_find_text').val('');
    toastr.success(`Filter "${name || trigger}" added`);
}

function editFilter(id) {
    const es = s(); const f = es.filters.find(x => x.id === id); if (!f) return;
    $('#ikarus_flt_name').val(f.name); $('#ikarus_flt_trigger').val(f.trigger);
    $('#ikarus_flt_match').val(f.matchMode || 'OR'); $('#ikarus_flt_action').val(f.action || 'remove');
    $('#ikarus_flt_action_text').val(f.actionText || ''); $('#ikarus_flt_find_text').val(f.findText || '');
    $('#ikarus_flt_target').val(f.target || 'positive');
    updateFilterFormVisibility();
    const idx = es.filters.findIndex(x => x.id === id);
    if (idx >= 0) es.filters.splice(idx, 1);
    saveSettingsDebounced(); renderFilterList();
    toastr.info(`Editing "${f.name}" — modify and click Add`);
}

function updateFilterFormVisibility() {
    const action = $('#ikarus_flt_action').val();
    $('#ikarus_flt_find_row').toggle(action === 'replace');
    const label = $('#ikarus_flt_action_label');
    const field = $('#ikarus_flt_action_text');
    if (action === 'remove') {
        label.text('Pattern to remove (comma-separated)');
        field.attr('placeholder', 'e.g. bad anatomy, extra fingers');
    } else if (action === 'append') {
        label.text('Text to append');
        field.attr('placeholder', 'e.g. moonlight, dark sky, night scene');
    } else if (action === 'replace') {
        label.text('Replace with');
        field.attr('placeholder', 'e.g. night, moonlight');
    }
}

// ==========================================================================
// Shared CRUD
// ==========================================================================
function deleteItem(id, type) {
    const es = s(); const list = type === 'replacement' ? es.replacements : es.filters;
    const idx = list.findIndex(x => x.id === id); if (idx < 0) return;
    const name = list[idx].name;
    if (type === 'replacement') {
        const childIds = es.replacements.filter(r => r.parentId === id).map(r => r.id);
        if (childIds.length && !confirm(`Delete "${name}" and its ${childIds.length} child(ren)?`)) return;
        else if (!childIds.length && !confirm(`Delete "${name}"?`)) return;
        es.replacements = es.replacements.filter(r => r.id !== id && r.parentId !== id);
    } else {
        if (!confirm(`Delete "${name}"?`)) return;
        list.splice(idx, 1);
    }
    saveSettingsDebounced();
    if (type === 'replacement') renderReplacementList(); else renderFilterList();
    toastr.success(`"${name}" deleted`);
}

function toggleItem(id, type) {
    const list = type === 'replacement' ? s().replacements : s().filters;
    const item = list.find(x => x.id === id); if (!item) return;
    item.enabled = !item.enabled; saveSettingsDebounced();
    if (type === 'replacement') renderReplacementList(); else renderFilterList();
}

function transferItem(id, type) {
    const es = s();
    const list = type === 'replacement' ? es.replacements : es.filters;
    const item = list.find(x => x.id === id); if (!item) return;
    const charId = getCurrentCharId();
    const charName = getCurrentCharName();

    if (item.scope === 'global') {
        // Global → Character
        if (!charId) { toastr.warning('Select a character first'); return; }
        item.scope = 'char'; item.charId = charId;
        // Also transfer children for replacements
        if (type === 'replacement') {
            es.replacements.filter(r => r.parentId === id).forEach(c => { c.scope = 'char'; c.charId = charId; });
        }
        toastr.success(`"${item.name}" moved to ${charName}`);
    } else {
        // Character → Global
        item.scope = 'global'; item.charId = null; item.folder = '';
        if (type === 'replacement') {
            es.replacements.filter(r => r.parentId === id).forEach(c => { c.scope = 'global'; c.charId = null; c.folder = ''; });
        }
        toastr.success(`"${item.name}" moved to Global`);
    }
    saveSettingsDebounced();
    if (type === 'replacement') renderReplacementList(); else renderFilterList();
}

// ==========================================================================
// Global Replacement Manager (folder popup)
// ==========================================================================
function openGlobalManager() {
    if ($('#ikarus_manager_overlay').length) return; // Already open
    const es = s();
    const overlay = $(`
    <div id="ikarus_manager_overlay" class="ikarus-manager-overlay">
        <div class="ikarus-manager-popup">
            <div class="ikarus-manager-header">
                <span>📂 Global Replacements Manager</span>
                <button id="ikarus_manager_close" class="menu_button" title="Close">✕</button>
            </div>
            <div class="ikarus-manager-body">
                <div class="ikarus-manager-sidebar">
                    <div class="ikarus-manager-folder-list" id="ikarus_folder_list"></div>
                    <div class="ikarus-manager-sidebar-bottom">
                        <div class="ikarus-manager-folder-add">
                            <input id="ikarus_folder_name" class="text_pole" placeholder="New folder..." />
                            <button id="ikarus_folder_create" class="menu_button" title="Create folder">＋</button>
                        </div>
                        <div class="ikarus-manager-folder-add">
                            <input id="ikarus_cat_name" class="text_pole" placeholder="New category..." />
                            <button id="ikarus_cat_create" class="menu_button" title="Create category">＋</button>
                        </div>
                    </div>
                </div>
                <div class="ikarus-manager-main">
                    <input id="ikarus_manager_search" class="text_pole" placeholder="🔍 Search by name or trigger..." />
                    <div id="ikarus_manager_cards" class="ikarus-manager-cards"></div>
                </div>
            </div>
        </div>
    </div>`);
    $('body').append(overlay);

    let activeFolder = null; // null = show all
    let searchQuery = '';

    function renderFolders() {
        const folders = es.repFolders || [];
        const categories = es.repCategories || [];
        const fc = es.folderCategories || {};
        let html = `<div class="ikarus-folder-item ${activeFolder === null ? 'active' : ''}" data-folder="__all__">📋 All</div>`;
        html += `<div class="ikarus-folder-item ${activeFolder === '' ? 'active' : ''}" data-folder="__unfiled__">📄 Unfiled</div>`;

        // Render categories with nested folders
        for (const cat of categories) {
            const catFolders = folders.filter(f => (fc[f] || '') === cat);
            html += `<div class="ikarus-cat-header">
                <span class="ikarus-cat-toggle" data-cat="${esc(cat)}">📚 ${esc(cat)}</span>
                <button class="ikarus-cat-delete" data-cat="${esc(cat)}" title="Delete category">✕</button>
            </div>`;
            html += `<div class="ikarus-cat-children" data-cat="${esc(cat)}">`;
            for (const f of catFolders) {
                html += `<div class="ikarus-folder-item ikarus-folder-nested ${activeFolder === f ? 'active' : ''}" data-folder="${esc(f)}">
                    <span>📁 ${esc(f)}</span>
                    <button class="ikarus-folder-delete" data-folder="${esc(f)}" title="Delete folder">✕</button>
                </div>`;
            }
            if (!catFolders.length) html += `<div class="ikarus-cat-empty">No folders</div>`;
            html += `</div>`;
        }

        // Uncategorized folders
        const uncatFolders = folders.filter(f => !fc[f] || !categories.includes(fc[f]));
        if (uncatFolders.length) {
            html += `<div class="ikarus-cat-header"><span>📌 Uncategorized</span></div>`;
            for (const f of uncatFolders) {
                html += `<div class="ikarus-folder-item ${activeFolder === f ? 'active' : ''}" data-folder="${esc(f)}">
                    <span>📁 ${esc(f)}</span>
                    <div class="ikarus-folder-item-actions">
                        <select class="ikarus-folder-cat-select" data-folder="${esc(f)}" title="Assign to category">
                            <option value="">—</option>
                            ${categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
                        </select>
                        <button class="ikarus-folder-delete" data-folder="${esc(f)}" title="Delete folder">✕</button>
                    </div>
                </div>`;
            }
        }
        $('#ikarus_folder_list').html(html);
    }

    function renderManagerCards() {
        const globals = (es.replacements || []).filter(r => r.scope === 'global' && !r.parentId);
        const q = searchQuery.toLowerCase();
        const filtered = globals.filter(r => {
            if (q && !(r.name || '').toLowerCase().includes(q) && !(r.trigger || '').toLowerCase().includes(q)) return false;
            if (activeFolder === null) return true;
            if (activeFolder === '') return !r.folder;
            return r.folder === activeFolder;
        });
        const folders = es.repFolders || [];
        const folderOpts = folders.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');

        let html = `<div class="ikarus-mgr-toolbar"><button id="ikarus_mgr_add" class="menu_button">➕ Add New Replacement</button></div>`;

        if (!filtered.length) {
            html += '<div style="text-align:center;opacity:0.4;padding:24px;">No replacements found.</div>';
            $('#ikarus_manager_cards').html(html);
            return;
        }
        for (const r of filtered) {
            const children = (es.replacements || []).filter(c => c.parentId === r.id);
            // Build selected folder option
            let selOpts = `<option value=""${!r.folder ? ' selected' : ''}>— Unfiled —</option>`;
            for (const f of folders) {
                selOpts += `<option value="${esc(f)}"${r.folder === f ? ' selected' : ''}>${esc(f)}</option>`;
            }
            html += `<div class="ikarus-mgr-card ${r.enabled ? '' : 'disabled'}" data-id="${esc(r.id)}">
                <div class="ikarus-mgr-card-top">
                    <span class="ikarus-mgr-name">${esc(r.name || 'Unnamed')}</span>
                    <div class="ikarus-mgr-actions">
                        <select class="ikarus-mgr-folder-select text_pole" data-id="${esc(r.id)}">${selOpts}</select>
                        <button class="menu_button ikarus-mgr-toggle" data-id="${esc(r.id)}" title="${r.enabled ? 'Disable' : 'Enable'}">${r.enabled ? '✅' : '⬜'}</button>
                        <button class="menu_button ikarus-mgr-edit" data-id="${esc(r.id)}" title="Edit">✏️</button>
                        <button class="menu_button ikarus-mgr-delete" data-id="${esc(r.id)}" title="Delete">🗑️</button>
                    </div>
                </div>
                <div class="ikarus-mgr-trigger"><b>Find:</b> ${esc(r.trigger)} <em>(${r.matchMode || 'OR'})</em></div>
                <div class="ikarus-mgr-replace"><b>→</b> ${esc((r.replacement || '').substring(0, 120))}${(r.replacement || '').length > 120 ? '…' : ''}</div>
                <div class="ikarus-mgr-meta">Mode: ${r.replaceMode === 'all' ? 'All' : 'First'} | P${r.priority || 0}${children.length ? ` | ${children.length} child(ren)` : ''}</div>
                <div class="ikarus-mgr-editform" id="ikarus_mgr_editform_${esc(r.id)}" style="display:none;"></div>
            </div>`;
        }
        $('#ikarus_manager_cards').html(html);
    }

    function showEditForm(rid) {
        const r = (es.replacements || []).find(x => x.id === rid);
        if (!r) return;
        const formId = `#ikarus_mgr_editform_${esc(rid)}`;
        $(formId).html(`
            <div class="ikarus-mgr-edit-grid">
                <label>Name</label><input class="text_pole mgr-ed-name" value="${esc(r.name || '')}" />
                <label>Trigger</label><input class="text_pole mgr-ed-trigger" value="${esc(r.trigger || '')}" />
                <label>Replacement</label><textarea class="text_pole mgr-ed-replacement" rows="2">${esc(r.replacement || '')}</textarea>
                <label>Match</label>
                <select class="text_pole mgr-ed-match">
                    <option value="OR"${r.matchMode === 'OR' ? ' selected' : ''}>OR</option>
                    <option value="AND"${r.matchMode === 'AND' ? ' selected' : ''}>AND</option>
                    <option value="CHILD"${r.matchMode === 'CHILD' ? ' selected' : ''}>CHILD</option>
                </select>
                <label>Replace Mode</label>
                <select class="text_pole mgr-ed-mode">
                    <option value="first"${r.replaceMode !== 'all' ? ' selected' : ''}>First</option>
                    <option value="all"${r.replaceMode === 'all' ? ' selected' : ''}>All</option>
                </select>
                <label>Priority</label><input class="text_pole mgr-ed-priority" type="number" value="${r.priority || 0}" />
            </div>
            <div class="ikarus-mgr-edit-btns">
                <button class="menu_button ikarus-mgr-save" data-id="${esc(rid)}">💾 Save</button>
                <button class="menu_button ikarus-mgr-cancel" data-id="${esc(rid)}">Cancel</button>
            </div>
        `).slideDown(150);
    }

    function showAddForm() {
        const folders = es.repFolders || [];
        let folderSel = `<option value="">— Unfiled —</option>`;
        for (const f of folders) {
            folderSel += `<option value="${esc(f)}"${activeFolder && activeFolder === f ? ' selected' : ''}>${esc(f)}</option>`;
        }
        const existing = $('#ikarus_mgr_addform');
        if (existing.length) { existing.slideToggle(150); return; }
        const form = $(`<div id="ikarus_mgr_addform" class="ikarus-mgr-card" style="border-color:var(--SmartThemeQuoteColor,#e0a0ff);">
            <div class="ikarus-mgr-name" style="margin-bottom:6px;">➕ New Replacement</div>
            <div class="ikarus-mgr-edit-grid">
                <label>Name</label><input class="text_pole mgr-new-name" placeholder="e.g. Bloom(Winx)" />
                <label>Trigger</label><input class="text_pole mgr-new-trigger" placeholder="e.g. bloom, Bloom winx, bloom winx club" />
                <label>Replacement</label><textarea class="text_pole mgr-new-replacement" rows="2" placeholder="e.g. &lt;lora:AnimaBloom:1&gt;Bloom,"></textarea>
                <label>Match</label>
                <select class="text_pole mgr-new-match"><option value="OR">OR</option><option value="AND">AND</option><option value="CHILD">CHILD</option></select>
                <label>Priority</label><input class="text_pole mgr-new-priority" type="number" value="0" />
                <label>Folder</label><select class="text_pole mgr-new-folder">${folderSel}</select>
            </div>
            <div class="ikarus-mgr-edit-btns">
                <button class="menu_button" id="ikarus_mgr_addconfirm">➕ Add</button>
                <button class="menu_button" id="ikarus_mgr_addcancel">Cancel</button>
            </div>
        </div>`);
        $('#ikarus_manager_cards .ikarus-mgr-toolbar').after(form);
    }

    renderFolders();
    renderManagerCards();

    // Events within the popup
    overlay.on('click', '#ikarus_manager_close', closeGlobalManager);
    overlay.on('click', function (e) { if ($(e.target).is('#ikarus_manager_overlay')) closeGlobalManager(); });
    overlay.on('click', '.ikarus-folder-item', function () {
        const f = $(this).data('folder');
        activeFolder = f === '__all__' ? null : (f === '__unfiled__' ? '' : f);
        renderFolders(); renderManagerCards();
    });
    overlay.on('click', '.ikarus-folder-delete', function (e) {
        e.stopPropagation();
        const fname = $(this).data('folder');
        if (!confirm(`Delete folder "${fname}"? Items will become unfiled.`)) return;
        es.repFolders = (es.repFolders || []).filter(f => f !== fname);
        (es.replacements || []).filter(r => r.folder === fname).forEach(r => { r.folder = ''; });
        if (es.folderCategories) delete es.folderCategories[fname];
        saveSettingsDebounced();
        if (activeFolder === fname) activeFolder = null;
        renderFolders(); renderManagerCards(); renderReplacementList();
    });
    overlay.on('click', '#ikarus_folder_create', function () {
        const name = $('#ikarus_folder_name').val()?.trim();
        if (!name) return;
        if ((es.repFolders || []).includes(name)) { toastr.warning('Folder already exists'); return; }
        if (!es.repFolders) es.repFolders = [];
        es.repFolders.push(name);
        saveSettingsDebounced();
        $('#ikarus_folder_name').val('');
        renderFolders(); renderManagerCards();
        toastr.success(`Folder "${name}" created`);
    });
    // Category CRUD
    overlay.on('click', '#ikarus_cat_create', function () {
        const name = $('#ikarus_cat_name').val()?.trim();
        if (!name) return;
        if ((es.repCategories || []).includes(name)) { toastr.warning('Category already exists'); return; }
        if (!es.repCategories) es.repCategories = [];
        es.repCategories.push(name);
        saveSettingsDebounced();
        $('#ikarus_cat_name').val('');
        renderFolders();
        toastr.success(`Category "${name}" created`);
    });
    overlay.on('click', '.ikarus-cat-delete', function (e) {
        e.stopPropagation();
        const cat = $(this).data('cat');
        if (!confirm(`Delete category "${cat}"? Folders will become uncategorized.`)) return;
        es.repCategories = (es.repCategories || []).filter(c => c !== cat);
        // Unassign folders from this category
        const fc = es.folderCategories || {};
        for (const f of Object.keys(fc)) { if (fc[f] === cat) delete fc[f]; }
        saveSettingsDebounced();
        renderFolders();
    });
    // Assign folder to category
    overlay.on('change', '.ikarus-folder-cat-select', function (e) {
        e.stopPropagation();
        const folder = $(this).data('folder');
        const cat = $(this).val();
        if (!es.folderCategories) es.folderCategories = {};
        if (cat) { es.folderCategories[folder] = cat; }
        else { delete es.folderCategories[folder]; }
        saveSettingsDebounced();
        renderFolders();
        toastr.success(`"${folder}" → ${cat || 'Uncategorized'}`);
    });
    overlay.on('input', '#ikarus_manager_search', function () {
        searchQuery = $(this).val() || '';
        renderManagerCards();
    });
    overlay.on('change', '.ikarus-mgr-folder-select', function () {
        const rid = $(this).data('id');
        const folder = $(this).val() || '';
        const r = (es.replacements || []).find(x => x.id === rid);
        if (r) {
            r.folder = folder;
            (es.replacements || []).filter(c => c.parentId === rid).forEach(c => { c.folder = folder; });
            saveSettingsDebounced(); renderReplacementList();
        }
    });
    // Toggle enable/disable
    overlay.on('click', '.ikarus-mgr-toggle', function () {
        const rid = $(this).data('id');
        const r = (es.replacements || []).find(x => x.id === rid); if (!r) return;
        r.enabled = !r.enabled;
        saveSettingsDebounced(); renderManagerCards(); renderReplacementList();
    });
    // Delete
    overlay.on('click', '.ikarus-mgr-delete', function () {
        const rid = $(this).data('id');
        const r = (es.replacements || []).find(x => x.id === rid); if (!r) return;
        const children = es.replacements.filter(c => c.parentId === rid);
        const msg = children.length ? `Delete "${r.name}" and its ${children.length} child(ren)?` : `Delete "${r.name}"?`;
        if (!confirm(msg)) return;
        es.replacements = es.replacements.filter(x => x.id !== rid && x.parentId !== rid);
        saveSettingsDebounced(); renderManagerCards(); renderReplacementList();
        toastr.success(`"${r.name}" deleted`);
    });
    // Edit — open inline form
    overlay.on('click', '.ikarus-mgr-edit', function () {
        showEditForm($(this).data('id'));
    });
    // Save edit
    overlay.on('click', '.ikarus-mgr-save', function () {
        const rid = $(this).data('id');
        const r = (es.replacements || []).find(x => x.id === rid); if (!r) return;
        const form = $(`#ikarus_mgr_editform_${esc(rid)}`);
        r.name = form.find('.mgr-ed-name').val()?.trim() || r.name;
        r.trigger = form.find('.mgr-ed-trigger').val()?.trim() || r.trigger;
        r.replacement = form.find('.mgr-ed-replacement').val()?.trim() || r.replacement;
        r.matchMode = form.find('.mgr-ed-match').val() || 'OR';
        r.replaceMode = form.find('.mgr-ed-mode').val() || 'first';
        r.priority = parseInt(form.find('.mgr-ed-priority').val()) || 0;
        saveSettingsDebounced(); renderManagerCards(); renderReplacementList();
        toastr.success(`"${r.name}" updated`);
    });
    // Cancel edit
    overlay.on('click', '.ikarus-mgr-cancel', function () {
        const rid = $(this).data('id');
        $(`#ikarus_mgr_editform_${esc(rid)}`).slideUp(150);
    });
    // Add new — show form
    overlay.on('click', '#ikarus_mgr_add', showAddForm);
    // Add new — confirm
    overlay.on('click', '#ikarus_mgr_addconfirm', function () {
        const trigger = $('#ikarus_mgr_addform .mgr-new-trigger').val()?.trim();
        const replacement = $('#ikarus_mgr_addform .mgr-new-replacement').val()?.trim();
        if (!trigger) { toastr.warning('Trigger is required'); return; }
        if (!replacement) { toastr.warning('Replacement text is required'); return; }
        es.replacements.push({
            id: uid(),
            name: $('#ikarus_mgr_addform .mgr-new-name').val()?.trim() || trigger,
            scope: 'global', charId: null,
            trigger,
            matchMode: $('#ikarus_mgr_addform .mgr-new-match').val() || 'OR',
            replacement,
            replaceMode: 'first',
            priority: parseInt($('#ikarus_mgr_addform .mgr-new-priority').val()) || 0,
            parentId: null, enabled: true,
            folder: $('#ikarus_mgr_addform .mgr-new-folder').val() || '',
        });
        saveSettingsDebounced(); renderManagerCards(); renderReplacementList();
        toastr.success('Replacement added');
    });
    // Add new — cancel
    overlay.on('click', '#ikarus_mgr_addcancel', function () {
        $('#ikarus_mgr_addform').slideUp(150, function () { $(this).remove(); });
    });
}

function closeGlobalManager() {
    $('#ikarus_manager_overlay').remove();
}

// ==========================================================================
// PROCESSING: Apply Replacements (in-place, with children priority)
// ==========================================================================
function applyReplacements(text) {
    const all = activeItems(s().replacements || []);
    if (!all.length) return text;

    const parents = all.filter(r => !r.parentId);
    let result = String(text || '');

    // Phase 1: Process parents, track which ones fired
    const firedParents = new Set();
    // Sort parents by priority (higher first)
    parents.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const parent of parents) {
        if (triggerMatches(result, parent)) {
            firedParents.add(parent.id);
            result = doReplace(result, parent);
            console.log(`[${EXT}] Replacement "${parent.name}" [P${parent.priority || 0}] applied`);
        }
    }

    // Phase 2: Process children
    // Gather all children, sort by priority (higher first)
    const allChildren = all.filter(r => r.parentId);
    allChildren.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Track which trigger keywords have been claimed (for CHILD mode priority conflict)
    const claimedKeywords = new Set();

    for (const child of allChildren) {
        const mode = child.matchMode || 'OR';

        if (mode === 'CHILD') {
            // CHILD mode: only fire if parent fired
            if (!firedParents.has(child.parentId)) continue;

            // Check if this child's trigger words conflict with an already-claimed keyword
            const keywords = child.trigger.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
            const conflicted = keywords.some(kw => claimedKeywords.has(kw));
            if (conflicted) {
                // A higher-priority child already claimed this keyword, skip
                console.log(`[${EXT}] Child "${child.name}" [P${child.priority || 0}] skipped (outprioritized)`);
                continue;
            }

            // Check if trigger words are present in the text
            if (keywords.some(kw => result.toLowerCase().includes(kw))) {
                result = doReplace(result, child);
                // Claim these keywords so lower-priority children can't use them
                keywords.forEach(kw => claimedKeywords.add(kw));
                console.log(`[${EXT}] Child "${child.name}" [CHILD, P${child.priority || 0}] applied`);
            }
        } else {
            // OR/AND mode: works independently, no parent dependency
            if (triggerMatches(result, child)) {
                result = doReplace(result, child);
                console.log(`[${EXT}] Child "${child.name}" [${mode}, P${child.priority || 0}] applied`);
            }
        }
    }

    return result;
}

function triggerMatches(text, rule) {
    const keywords = rule.trigger.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (!keywords.length) return false;
    const lower = text.toLowerCase();
    if (rule.matchMode === 'AND') return keywords.every(kw => lower.includes(kw));
    // OR is default for parents; CHILD mode is handled separately in applyReplacements
    return keywords.some(kw => lower.includes(kw));
}

function doReplace(text, rule) {
    const keywords = rule.trigger.split(',').map(k => k.trim()).filter(Boolean);
    let result = text;
    for (const kw of keywords) {
        const escaped = escRegex(kw);
        const flags = rule.replaceMode === 'all' ? 'gi' : 'i';
        result = result.replace(new RegExp(`\\b${escaped}\\b`, flags), rule.replacement.trim());
    }
    return cleanPrompt(result);
}

// ==========================================================================
// PROCESSING: Apply Filters (trigger-based, remove/append/replace)
// ==========================================================================
function applyFiltersToPrompt(prompt, negative) {
    const rules = activeItems(s().filters || []);
    if (!rules.length) return { prompt, negative };

    let p = String(prompt || '');
    let n = String(negative || '');
    // Combine for trigger matching
    const combined = `${p} ${n}`;

    for (const f of rules) {
        if (!triggerMatches(combined, f)) continue;

        const target = f.target || 'positive';
        const action = f.action || 'remove';

        if (action === 'remove') {
            const pattern = f.actionText.trim();
            if (!pattern) continue;
            // Remove each comma-separated pattern
            const patterns = pattern.split(',').map(x => x.trim()).filter(Boolean);
            for (const pat of patterns) {
                const escaped = escRegex(pat);
                const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
                if (target === 'positive' || target === 'both') p = p.replace(regex, '');
                if (target === 'negative' || target === 'both') n = n.replace(regex, '');
            }
            console.log(`[${EXT}] Filter "${f.name}" removed: ${pattern}`);
        } else if (action === 'append') {
            const appendText = f.actionText.trim();
            if (!appendText) continue;
            if (target === 'positive' || target === 'both') p = joinPrompt(p, appendText);
            if (target === 'negative' || target === 'both') n = joinPrompt(n, appendText);
            console.log(`[${EXT}] Filter "${f.name}" appended: ${appendText.substring(0, 50)}`);
        } else if (action === 'replace') {
            const find = f.findText.trim();
            const replaceWith = f.actionText.trim();
            if (!find) continue;
            const escaped = escRegex(find);
            const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
            if (target === 'positive' || target === 'both') p = p.replace(regex, replaceWith);
            if (target === 'negative' || target === 'both') n = n.replace(regex, replaceWith);
            console.log(`[${EXT}] Filter "${f.name}" replaced: ${find} → ${replaceWith.substring(0, 50)}`);
        }
    }

    return { prompt: cleanPrompt(p), negative: cleanPrompt(n) };
}

// ==========================================================================
// PROCESSING: Double Cleaner — strip duplicate tags
// ==========================================================================
function applyDoubleCleaner(text) {
    const dc = s().doubleCleaner;
    if (!dc || dc.mode === 'none') return text;

    const tokens = text.split(',').map(t => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return text;

    if (dc.mode === 'all') {
        // Strip ALL duplicate tags, keep first occurrence
        const seen = new Set();
        const unique = [];
        for (const token of tokens) {
            const key = token.toLowerCase();
            if (!seen.has(key)) { seen.add(key); unique.push(token); }
        }
        const result = unique.join(', ');
        if (result !== text) console.log(`[${EXT}] Double cleaner: stripped ${tokens.length - unique.length} duplicate(s)`);
        return result;
    }

    if (dc.mode === 'listed') {
        // Only strip duplicates of specific listed tags
        const watchList = new Set((dc.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
        if (!watchList.size) return text;
        const seenWatched = new Set();
        const result = [];
        for (const token of tokens) {
            const key = token.toLowerCase();
            if (watchList.has(key)) {
                if (!seenWatched.has(key)) { seenWatched.add(key); result.push(token); }
                // else skip duplicate
            } else {
                result.push(token);
            }
        }
        const joined = result.join(', ');
        if (joined !== text) console.log(`[${EXT}] Double cleaner (listed): stripped duplicates of watched tags`);
        return joined;
    }

    return text;
}

// ==========================================================================
// Text utilities
// ==========================================================================
function cleanPrompt(text) {
    return text.replace(/,\s*,/g, ',').replace(/^\s*,\s*/g, '').replace(/\s*,\s*$/g, '').replace(/\s{2,}/g, ' ').trim();
}
function joinPrompt(base, addition) {
    const b = base.trim(), a = addition.trim();
    if (!b) return a; if (!a) return b; return `${b}, ${a}`;
}

// ==========================================================================
// MASTER PROCESSING PIPELINE
// ==========================================================================
function processPrompt(prompt, negative) {
    const es = s();
    let p = String(prompt || '');
    let n = String(negative || '');

    if (es.invertProcessingOrder) {
        // Filters first
        const fResult = applyFiltersToPrompt(p, n); p = fResult.prompt; n = fResult.negative;
        p = applyReplacements(p);
    } else {
        // Replacements first (default)
        p = applyReplacements(p);
        const fResult = applyFiltersToPrompt(p, n); p = fResult.prompt; n = fResult.negative;
    }

    // Double cleaner runs last
    p = applyDoubleCleaner(p);
    n = applyDoubleCleaner(n);

    return { prompt: p, negative: n };
}

// ==========================================================================
// Auto-Cleaner (message tag cleanup)
// ==========================================================================
function cleanTagsFromMessage(message, regexPattern) {
    if (!message || typeof message !== 'object') return false;
    let changed = false;
    const clean = (h, k) => {
        if (!h || typeof h[k] !== 'string' || !h[k].trim()) return;
        try { const next = h[k].replace(new RegExp(regexPattern, 'gi'), '').trim(); if (next !== h[k]) { h[k] = next; changed = true; } } catch { }
    };
    clean(message, 'mes'); clean(message?.extra, 'display_text');
    clean(message?.extra, 'reasoning_display_text'); clean(message?.extra, 'reasoning');
    if (Array.isArray(message.swipes)) {
        const sid = Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
        if (typeof message.swipes[sid] === 'string') {
            try { const next = message.swipes[sid].replace(new RegExp(regexPattern, 'gi'), '').trim(); if (next !== message.swipes[sid]) { message.swipes[sid] = next; changed = true; } } catch { }
        }
    }
    return changed;
}

// ==========================================================================
// Prompt Injection
// ==========================================================================
function getMesRole() {
    switch (s().promptInjection?.position) { case 'deep_user': return 'user'; case 'deep_assistant': return 'assistant'; default: return 'system'; }
}

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async function (eventData) {
    try {
        const es = s();
        if (!es.promptInjection?.enabled || es.insertType === INSERT_TYPE.DISABLED) return;
        let promptText = es.promptInjection.prompt;
        // Replace {CharacterPersonalised-prompt} macro with per-character text
        const charPrompt = getCharPromptText();
        promptText = promptText.replace(/\{CharacterPersonalised-prompt\}/gi, charPrompt);
        const d = es.promptInjection.depth || 0;
        const role = getMesRole();
        if (!d) eventData.chat.push({ role, content: promptText });
        else eventData.chat.splice(-d, 0, { role, content: promptText });
        console.log(`[${EXT}] Prompt injected: role=${role}, depth=${d}, charPrompt=${charPrompt ? 'yes' : 'none'}`);
    } catch (error) { console.error(`[${EXT}] Prompt injection error:`, error); }
});

// ==========================================================================
// Character change detection — auto-refresh when switching cards
// ==========================================================================
eventSource.on(event_types.CHAT_CHANGED, function () {
    console.log(`[${EXT}] Chat changed — refreshing character-specific UI`);
    migrateCharKeys();
    loadCharPrompt();
    // Auto-switch to character scope and update tab UI
    const charId = getCurrentCharId();
    const charName = getCurrentCharName();
    if (charId) {
        // Switch replacements to character scope
        currentRepScope = 'char';
        $('#ikarus_rep_scope_global').removeClass('active');
        $('#ikarus_rep_scope_char').addClass('active').text(`👤 ${charName}`);
        // Switch filters to character scope
        currentFltScope = 'char';
        $('#ikarus_flt_scope_global').removeClass('active');
        $('#ikarus_flt_scope_char').addClass('active').text(`👤 ${charName}`);
    }
    renderReplacementList();
    renderFilterList();
});

// ==========================================================================
// Message Handler — detect → process → generate
// ==========================================================================
eventSource.on(event_types.MESSAGE_RECEIVED, handleIncomingMessage);

async function handleIncomingMessage() {
    const es = s();
    if (!es || es.insertType === INSERT_TYPE.DISABLED) return;
    const context = getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user || !es.promptInjection?.regex) return;

    const imgTagRegex = regexFromString(es.promptInjection.regex);
    let matches;
    if (imgTagRegex.global) matches = [...message.mes.matchAll(imgTagRegex)];
    else { const m = message.mes.match(imgTagRegex); matches = m ? [m] : []; }
    if (!matches.length) return;

    const mesIdx = context.chat.length - 1;

    setTimeout(async () => {
        try {
            toastr.info(`Generating ${matches.length} image(s)...`);
            if (!message.extra) message.extra = {};
            if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
            if (message.extra.image && !message.extra.image_swipes.includes(message.extra.image)) message.extra.image_swipes.push(message.extra.image);

            for (const match of matches) {
                let imgPrompt = typeof match?.[1] === 'string' ? match[1] : '';
                if (!imgPrompt.trim()) continue;

                // Run the full processing pipeline
                const processed = processPrompt(imgPrompt, '');
                imgPrompt = processed.prompt;

                const result = await SlashCommandParser.commands['sd'].callback(
                    { quiet: es.insertType === INSERT_TYPE.NEW_MESSAGE ? 'false' : 'true' }, imgPrompt);

                if (es.insertType === INSERT_TYPE.INLINE && typeof result === 'string' && result.trim()) {
                    message.extra.image_swipes.push(result); message.extra.image = result;
                    message.extra.title = imgPrompt; message.extra.inline_image = true;
                    const messageElement = $(`.mes[mesid="${mesIdx}"]`);
                    appendMediaToMessage(message, messageElement); await context.saveChat();
                } else if (es.insertType === INSERT_TYPE.REPLACE && typeof result === 'string' && result.trim()) {
                    const tag = typeof match?.[0] === 'string' ? match[0] : ''; if (!tag) continue;
                    // Slim img tag: only src, no bloated title/alt with full prompt
                    message.mes = message.mes.replace(tag, `<img src="${esc(result)}">`);
                    updateMessageBlock(mesIdx, message);
                    await eventSource.emit(event_types.MESSAGE_UPDATED, mesIdx); await context.saveChat();
                }
            }

            // Auto-clean AFTER generation — strips [pic] tags from message text
            // Images are already stored (extra.image for inline, <img> for replace)
            if (es.autoClean) {
                try {
                    const cleanPattern = es.promptInjection.regex.replace(/^\/|\/[gimsuy]*$/g, '');
                    if (cleanTagsFromMessage(message, cleanPattern)) {
                        await context.saveChat();
                        console.log(`[${EXT}] Auto-cleaned remaining tags from message`);
                    }
                } catch (e) { console.error(`[${EXT}] Auto-clean error:`, e); }
            }

            toastr.success(`${matches.length} image(s) generated`);
        } catch (error) { toastr.error(`Error: ${error}`); console.error(`[${EXT}]`, error); }
    }, 0);
}

// ==========================================================================
// UI Setup
// ==========================================================================
let _addChildParentId = null;

async function createSettings(html) {
    if (!$('#ikarus_auto_image_container').length) {
        $('#extensions_settings2').append('<div id="ikarus_auto_image_container" class="extension_container"></div>');
    }
    $('#ikarus_auto_image_container').empty().append(html);

    // Section 1: Image Generation
    $('#ikarus_insert_type').on('change', function () { s().insertType = $(this).val(); updateUI(); saveSettingsDebounced(); });
    $('#ikarus_prompt_injection_enabled').on('change', function () { s().promptInjection.enabled = $(this).prop('checked'); saveSettingsDebounced(); });

    // Section 2: Presets
    $('#ikarus_prompt_text').on('input', function () { s().promptInjection.prompt = $(this).val(); saveSettingsDebounced(); });
    $('#ikarus_prompt_regex').on('input', function () { s().promptInjection.regex = $(this).val(); saveSettingsDebounced(); });
    $('#ikarus_prompt_position').on('change', function () { s().promptInjection.position = $(this).val(); saveSettingsDebounced(); });
    $('#ikarus_prompt_depth').on('input', function () { s().promptInjection.depth = parseInt($(this).val()) || 0; saveSettingsDebounced(); });
    $('#ikarus_preset_select').on('change', function () { loadPreset($(this).val()); });
    $('#ikarus_preset_save').on('click', savePreset);
    $('#ikarus_preset_delete').on('click', deletePreset);

    // Character Prompt (per-card, 5 slots)
    $('#ikarus_char_prompt').on('input', saveCharPrompt);
    $(document).on('click', '.ikarus-slot-btn', function () {
        switchCharSlot(parseInt($(this).data('slot')) || 0);
    });

    // Section 3: Replacements
    $('#ikarus_rep_scope_global').on('click', function () { currentRepScope = 'global'; $(this).addClass('active'); $('#ikarus_rep_scope_char').removeClass('active'); renderReplacementList(); });
    $('#ikarus_rep_scope_char').on('click', function () { currentRepScope = 'char'; $(this).addClass('active'); $('#ikarus_rep_scope_global').removeClass('active'); $(this).text(`👤 ${getCurrentCharName()}`); renderReplacementList(); });
    $('#ikarus_rep_add').on('click', function () {
        const pid = _addChildParentId || $(this).data('parent-id') || null;
        addReplacement(pid);
        _addChildParentId = null;
        $('#ikarus_rep_add').text('➕ Add Replacement');
    });

    // Section 4: Filters
    $('#ikarus_flt_scope_global').on('click', function () { currentFltScope = 'global'; $(this).addClass('active'); $('#ikarus_flt_scope_char').removeClass('active'); renderFilterList(); });
    $('#ikarus_flt_scope_char').on('click', function () { currentFltScope = 'char'; $(this).addClass('active'); $('#ikarus_flt_scope_global').removeClass('active'); $(this).text(`👤 ${getCurrentCharName()}`); renderFilterList(); });
    $('#ikarus_flt_add').on('click', addFilter);
    $('#ikarus_flt_action').on('change', updateFilterFormVisibility);

    // Section 5: Processing & Cleaners
    $('#ikarus_invert_order').on('change', function () { s().invertProcessingOrder = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#ikarus_auto_clean').on('change', function () { s().autoClean = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#ikarus_dc_mode').on('change', function () {
        s().doubleCleaner.mode = $(this).val(); saveSettingsDebounced();
        $('#ikarus_dc_tags_row').toggle($(this).val() === 'listed');
    });
    $('#ikarus_dc_tags').on('input', function () { s().doubleCleaner.tags = $(this).val(); saveSettingsDebounced(); });

    // Delegated events
    $(document).on('click', '.ikarus-delete-item', function () { const c = $(this).closest('.ikarus-card'); deleteItem(c.data('id'), c.data('type')); });
    $(document).on('click', '.ikarus-toggle-item', function () { const c = $(this).closest('.ikarus-card'); toggleItem(c.data('id'), c.data('type')); });
    $(document).on('click', '.ikarus-edit-item', function () {
        const c = $(this).closest('.ikarus-card'); const id = c.data('id'); const type = c.data('type');
        if (type === 'replacement') editReplacement(id); else editFilter(id);
    });
    $(document).on('click', '.ikarus-add-child', function () {
        const parentId = $(this).closest('.ikarus-card').data('id');
        const parentName = s().replacements.find(r => r.id === parentId)?.name || '';
        _addChildParentId = parentId;
        $('#ikarus_rep_add').text(`➕ Add Child of "${parentName}"`);
        $('#ikarus_rep_name').focus();
        toastr.info(`Adding child for "${parentName}". Fill the form and click Add.`);
    });
    $(document).on('click', '.ikarus-transfer-item', function () {
        const c = $(this).closest('.ikarus-card');
        transferItem(c.data('id'), c.data('type'));
    });
    $('#ikarus_rep_manage').on('click', openGlobalManager);

    updateUI();
    updateFilterFormVisibility();
}

// ==========================================================================
// Extension Menu Button
// ==========================================================================
function onMenuButtonClick() {
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');
    if ($('#rm_extensions_block').hasClass('closedDrawer')) extensionsDrawer.trigger('click');
    setTimeout(() => {
        const c = $('#ikarus_auto_image_container');
        if (c.length) {
            $('#rm_extensions_block').animate({ scrollTop: c.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop() }, 500);
            if (c.find('.inline-drawer-content').is(':hidden') && c.find('.inline-drawer-header').length) c.find('.inline-drawer-header').trigger('click');
        }
    }, 500);
}

// ==========================================================================
// Init
// ==========================================================================
$(function () {
    (async function () {
        ensureSettings();
        migrateCharKeys();
        const settingsHtml = await $.get(`${EXT_PATH}/settings.html`);
        $('#extensionsMenu').append(`<div id="ikarus_auto_image_btn" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-feather"></div><span>Ikarus Auto Image</span></div>`);
        $('#ikarus_auto_image_btn').off('click').on('click', onMenuButtonClick);
        await createSettings(settingsHtml);
        $('#extensions-settings-button').on('click', () => setTimeout(updateUI, 200));
        console.log(`[${EXT}] Extension loaded`);
    })();
});
