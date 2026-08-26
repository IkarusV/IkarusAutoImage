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
    setExtensionPrompt,
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
    extension_prompts,
} from '../../../../script.js';
import { appendMediaToMessage } from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

// ==========================================================================
// Constants
// ==========================================================================
const EXT = 'IkarusAutoImage';
const EXT_PATH = `/scripts/extensions/third-party/${EXT}`;
const PROMPT_KEY = `${EXT}_PROMPT`;

const INSERT_TYPE = { DISABLED: 'disabled', INLINE: 'inline', NEW_MESSAGE: 'new', REPLACE: 'replace' };

const DEFAULT_PROMPT = `<image_generation>
You must insert a <pic prompt="example prompt"> at end of the reply. Prompts are used for stable diffusion image generation, based on the plot and character to output appropriate prompts to generate captivating images.
</image_generation>`;

const DEFAULT_REGEX = '/\\[pic[^\\]]*?prompt="([^"]*)"[^\\]]*?\\]/g';
const FALLBACK_PIC_REGEX = /[\[<]pic\b[^>\]]*?prompt="([^"]*)"[^>\]]*?[\]>]/gi;

const DEFAULT_SETTINGS = {
    insertType: INSERT_TYPE.DISABLED,
    promptInjection: { enabled: true, prompt: DEFAULT_PROMPT, regex: DEFAULT_REGEX, position: 'deep_system', depth: 0 },
    presets: [],
    activePresetId: '', // currently selected preset ID
    // Per-character prompt: keyed by charId → string
    charPrompts: {},
    charPrefixes: {},
    // Replacements: {id, name, scope, charId, trigger, matchMode, replacement, caption, replaceMode, priority, parentId, enabled, folder}
    replacements: [],
    repFieldMode: 'tags', // 'tags' or 'caption' — which field to use during replacement
    repFolders: [], // folder names for organizing global replacements
    repCategories: [], // category names (parent of folders)
    folderCategories: {}, // mapping: folder name → category name
    // Filters: {id, name, scope, charId, trigger, matchMode, action, actionText, findText, target, enabled}
    filters: [],
    replacementsEnabled: true, // master switch; preserves each rule's enabled state
    invertProcessingOrder: false, // false = replacements first, true = filters first
    // Double cleaner: strips duplicate tags after all processing
    doubleCleaner: { mode: 'none', tags: '' }, // mode: 'none' | 'all' | 'listed'
    autoClean: false,
    autoFixPicFormat: false, // when true, normalizes malformed pic prompts to [pic prompt="..."] before extraction
    filterNativeSd: true, // when true, runs the prompt pipeline on all native /sd prompts before generation
    generationMode: 'together', // 'together' | 'separate' | 'standalone'
    standalone: { auto: false, contextSize: 5, imageCount: 3, profile: '', systemPrompt: '', libraries: {}, bubbleOpen: false, hideBubble: false, includeCharacterCard: false, includeFirstMessage: false, includeExtensionPrompts: false },
    separateProfile: '', // connection profile ID for separate mode (empty = current)
    separateContextSize: 1, // 0 = all AI messages, N = last N AI messages
    separateEnabled: true, // whether separate mode second API call is active
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

        // Migrate charPrefixes
        if (es.charPrefixes) {
            for (const [oldKey, newKey] of Object.entries(keyMap)) {
                if (es.charPrefixes[oldKey] && !es.charPrefixes[newKey]) {
                    es.charPrefixes[newKey] = es.charPrefixes[oldKey];
                    delete es.charPrefixes[oldKey];
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
    if (!es.charPrefixes || typeof es.charPrefixes !== 'object') es.charPrefixes = {};
    if (!Array.isArray(es.replacements)) es.replacements = [];
    if (!Array.isArray(es.repFolders)) es.repFolders = [];
    if (!Array.isArray(es.repCategories)) es.repCategories = [];
    if (!es.folderCategories || typeof es.folderCategories !== 'object') es.folderCategories = {};
    if (!['tags', 'caption', 'krea2'].includes(es.repFieldMode)) es.repFieldMode = 'tags';
    if (!es.characterLibrary || typeof es.characterLibrary !== 'object') es.characterLibrary = { folders: [] };
    if (!Array.isArray(es.characterLibrary.folders)) es.characterLibrary.folders = [];
    // Ensure each replacement has folder, caption, Krea 2, and shortTag fields
    for (const r of (es.replacements || [])) {
        if (r.folder === undefined) r.folder = '';
        if (r.caption === undefined) r.caption = r.replacement || '';
        if (r.krea2 === undefined) r.krea2 = r.caption || r.replacement || '';
        if (r.shortTag === undefined) r.shortTag = '';
    }
    if (!Array.isArray(es.filters)) es.filters = [];
    if (es.replacementsEnabled === undefined) es.replacementsEnabled = true;
    if (es.invertProcessingOrder === undefined) es.invertProcessingOrder = false;
    if (!es.doubleCleaner) es.doubleCleaner = { ...DEFAULT_SETTINGS.doubleCleaner };
    if (es.autoClean === undefined) es.autoClean = false;
    if (es.autoFixPicFormat === undefined) es.autoFixPicFormat = false;
    if (es.filterNativeSd === undefined) es.filterNativeSd = true;
    if (!es.generationMode) es.generationMode = DEFAULT_SETTINGS.generationMode;
    if (es.separateProfile === undefined) es.separateProfile = DEFAULT_SETTINGS.separateProfile;
    if (es.separateContextSize === undefined) es.separateContextSize = DEFAULT_SETTINGS.separateContextSize;
    if (es.separateEnabled === undefined) es.separateEnabled = DEFAULT_SETTINGS.separateEnabled;
    if (!es.standalone || typeof es.standalone !== 'object') es.standalone = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.standalone));
    for (const [k,v] of Object.entries(DEFAULT_SETTINGS.standalone)) if (es.standalone[k] === undefined) es.standalone[k] = JSON.parse(JSON.stringify(v));
    if (es.standalone.hideBubble === undefined) es.standalone.hideBubble = false;
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
        const isAppend = es.promptInjection.position === 'append_user';
        const isMacro = es.promptInjection.position === 'macro';
        // Hide depth controls when append_user or macro is selected
        $('#ikarus_prompt_position').closest('.ikarus-row').find('div:last-child').toggle(!isAppend && !isMacro);
        $('#ikarus_append_user_hint').toggle(isAppend);
        $('#ikarus_macro_hint').toggle(isMacro);
        $('#ikarus_prompt_depth').val(es.promptInjection.depth);
        $('#ikarus_replacements_enabled').prop('checked', es.replacementsEnabled !== false);
        $('#ikarus_invert_order').prop('checked', es.invertProcessingOrder);
        $('#ikarus_auto_clean').prop('checked', es.autoClean);
        $('#ikarus_auto_fix_pic').prop('checked', es.autoFixPicFormat);
        $('#ikarus_filter_native_sd').prop('checked', es.filterNativeSd);
        $('#ikarus_dc_mode').val(es.doubleCleaner?.mode || 'none');
        $('#ikarus_dc_tags').val(es.doubleCleaner?.tags || '');
        $('#ikarus_dc_tags_row').toggle(es.doubleCleaner?.mode === 'listed');
        $('#ikarus_generation_mode').val(es.generationMode || 'together');
        $('.ikarus-separate-options').toggle(es.generationMode === 'separate');
        $('.ikarus-standalone-options').toggle(es.generationMode === 'standalone');
        $('#ikarus_standalone_auto').prop('checked', !!es.standalone.auto);
        $('#ikarus_standalone_context').val(es.standalone.contextSize);
        $('#ikarus_standalone_count').val(es.standalone.imageCount);
        $('#ikarus_standalone_profile').val(es.standalone.profile || '');
        $('#ikarus_standalone_system').val(es.standalone.systemPrompt || '');
        $('#ikarus_separate_enabled').prop('checked', es.separateEnabled !== false);
        $('#ikarus_separate_context_size').val(es.separateContextSize ?? 1);
        populateProfileDropdown();
    }
    renderPresetDropdown();
    loadCharPrompt();
    loadCharPrefix();
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
    syncPromptInjection(); saveSettingsDebounced(); updateUI();
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
    syncPromptInjection();
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

function getCharPrefix() {
    const charId = getCurrentCharId();
    if (!charId) return '';
    return s().charPrefixes[charId] || '';
}

function loadCharPrefix() {
    const $textarea = $('#ikarus_char_prefix');
    if (!$textarea.length) return;
    const charId = getCurrentCharId();
    if (!charId) {
        $textarea.val('').attr('placeholder', 'Select a character first...');
        $('#ikarus_char_prefix_label').text('Char Prefix (no character)');
        return;
    }
    const charName = getCurrentCharName();
    $textarea.val(s().charPrefixes[charId] || '').attr('placeholder', `Prefix for ${charName}... (e.g. <lora:naruto:0.8>)`);
    $('#ikarus_char_prefix_label').text(`Char Prefix — ${charName}`);
}

function saveCharPrefix() {
    const charId = getCurrentCharId();
    if (!charId) return;
    s().charPrefixes[charId] = $('#ikarus_char_prefix').val() || '';
    saveSettingsDebounced();
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

function normalizeReplacementTriggerGroups(r) { if (Array.isArray(r?.triggerGroups) && r.triggerGroups.length) return r.triggerGroups.map((g,i)=>({ trigger:String(g?.trigger||'').trim(), matchMode:['OR','AND','XOR','NOR','CHILD'].includes(g?.matchMode) && (g.matchMode!=='CHILD'||i===0) ? g.matchMode : 'OR' })).filter(g=>g.trigger); const trigger=String(r?.trigger||'').trim(); return trigger ? [{trigger,matchMode:r?.matchMode||'OR'}] : []; }
function renderReplacementTriggerGroups(groups=[{trigger:'',matchMode:'OR'}]) { const rows=groups.length?groups:[{trigger:'',matchMode:'OR'}], isChild=!!(_addChildParentId||$('#ikarus_rep_add').data('parent-id')); $('#ikarus_rep_trigger_groups').html(rows.map((g,i)=>`<div class="ikarus-trigger-group"><input class="text_pole ikarus-rep-group-trigger" value="${esc(g.trigger||'')}" placeholder="e.g. Alice"><select class="text_pole ikarus-rep-group-mode"><option value="OR" ${g.matchMode==='OR'?'selected':''}>OR (any)</option><option value="AND" ${g.matchMode==='AND'?'selected':''}>AND (all)</option><option value="XOR" ${g.matchMode==='XOR'?'selected':''}>XOR (exactly one)</option><option value="NOR" ${g.matchMode==='NOR'?'selected':''}>NOR (none)</option>${i===0&&isChild?`<option value="CHILD" ${g.matchMode==='CHILD'?'selected':''}>CHILD (parent must fire)</option>`:''}</select>${i?'<button type="button" class="menu_button ikarus-trigger-group-remove">&times;</button>':''}</div>`).join('')); }
function readReplacementTriggerGroups(){ return $('#ikarus_rep_trigger_groups .ikarus-trigger-group').map(function(){return {trigger:$(this).find('.ikarus-rep-group-trigger').val()?.trim()||'',matchMode:$(this).find('.ikarus-rep-group-mode').val()||'OR'};}).get().filter(g=>g.trigger); }
function replacementTriggerGroupsLabel(r){return normalizeReplacementTriggerGroups(r).map(g=>`${g.trigger} (${g.matchMode})`).join(' AND ');}

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
            <div><b class="trigger-label">Find:</b> ${esc(replacementTriggerGroupsLabel(r))}</div>
            <div><b class="replace-label">🏷️</b> ${esc((r.replacement || '').substring(0, 100))}${(r.replacement || '').length > 100 ? '…' : ''}</div>
            ${r.caption && r.caption !== r.replacement ? `<div><b class="replace-label">💬</b> ${esc((r.caption || '').substring(0, 100))}${(r.caption || '').length > 100 ? '…' : ''}</div>` : ''}
            ${r.replaceMode === 'first_full' && r.shortTag ? `<div><b class="replace-label">🔁</b> ${esc((r.shortTag || '').substring(0, 80))}${(r.shortTag || '').length > 80 ? '…' : ''}</div>` : ''}
            <div>Mode: ${r.replaceMode === 'all' ? 'All' : r.replaceMode === 'first_full' ? '1st Full' : 'First'} | P${r.priority || 0} | <span class="scope-badge">${r.scope === 'char' ? '👤' : '🌐'}</span>${r.folder ? ` | 📁 ${esc(r.folder)}` : ''} | ${s().repFieldMode === 'caption' ? '💬' : '🏷️'}</div>
        </div>
    </div>`;
}

function addReplacement(parentId) {
    const name = $('#ikarus_rep_name').val()?.trim();
    const triggerGroups = readReplacementTriggerGroups();
    const trigger = triggerGroups[0]?.trigger || '';
    const replacement = $('#ikarus_rep_replacement').val()?.trim();
    const caption = $('#ikarus_rep_caption').val()?.trim() || replacement;
    const krea2 = $('#ikarus_rep_krea2').val()?.trim() || caption || replacement;
    const shortTag = $('#ikarus_rep_short_tag').val()?.trim();
    const matchMode = triggerGroups[0]?.matchMode || 'OR';
    const replaceMode = $('#ikarus_rep_mode').val() || 'first';
    const priority = parseInt($('#ikarus_rep_priority').val()) || 0;

    if (!trigger) { toastr.warning('Trigger is required'); return; }
    if (!replacement && !caption && !krea2) { toastr.warning('Tags, Caption, or Krea 2 text is required'); return; }

    s().replacements.push({
        id: uid(), name: name || trigger, scope: currentRepScope,
        charId: currentRepScope === 'char' ? getCurrentCharId() : null,
        trigger, matchMode, triggerGroups, replacement: replacement || caption || krea2, caption: caption || replacement || krea2, krea2: krea2 || caption || replacement,
        shortTag: shortTag || '',
        replaceMode, priority,
        parentId: parentId || null, enabled: true,
    });
    saveSettingsDebounced(); renderReplacementList();
    $('#ikarus_rep_name, #ikarus_rep_replacement, #ikarus_rep_caption, #ikarus_rep_krea2, #ikarus_rep_short_tag').val('');
    renderReplacementTriggerGroups();
    $('#ikarus_rep_priority').val('0');
    toastr.success(`Replacement "${name || trigger}" added${parentId ? ' as child' : ''}`);
}

function editReplacement(id) {
    const es = s(); const r = es.replacements.find(x => x.id === id); if (!r) return;
    $('#ikarus_rep_name').val(r.name); renderReplacementTriggerGroups(normalizeReplacementTriggerGroups(r));
    $('#ikarus_rep_replacement').val(r.replacement); $('#ikarus_rep_caption').val(r.caption || ''); $('#ikarus_rep_krea2').val(r.krea2 || '');
    $('#ikarus_rep_short_tag').val(r.shortTag || '');
    $('#ikarus_rep_match').val(r.matchMode || 'OR');
    $('#ikarus_rep_mode').val(r.replaceMode || 'first'); $('#ikarus_rep_priority').val(r.priority || 0);
    // Show/hide short tag row based on loaded mode
    $('#ikarus_rep_short_tag_row').toggle(r.replaceMode === 'first_full');
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
function normalizeFilterTriggerGroups(f){if(Array.isArray(f?.triggerGroups)&&f.triggerGroups.length)return f.triggerGroups.map(g=>({trigger:String(g?.trigger||'').trim(),matchMode:['OR','AND','XOR','NOR'].includes(g?.matchMode)?g.matchMode:'OR'})).filter(g=>g.trigger);const t=String(f?.trigger||'').trim();return t?[{trigger:t,matchMode:f?.matchMode==='AND'?'AND':'OR'}]:[];}
function renderFilterTriggerGroups(groups=[{trigger:'',matchMode:'OR'}]){const rows=groups.length?groups:[{trigger:'',matchMode:'OR'}];$('#ikarus_flt_trigger_groups').html(rows.map((g,i)=>`<div class="ikarus-trigger-group"><input class="text_pole ikarus-flt-group-trigger" value="${esc(g.trigger||'')}" placeholder="e.g. hat, shirt"><select class="text_pole ikarus-flt-group-mode"><option value="OR" ${g.matchMode==='OR'?'selected':''}>OR (any)</option><option value="AND" ${g.matchMode==='AND'?'selected':''}>AND (all)</option><option value="XOR" ${g.matchMode==='XOR'?'selected':''}>XOR (exactly one)</option><option value="NOR" ${g.matchMode==='NOR'?'selected':''}>NOR (none)</option></select>${i?'<button type="button" class="menu_button ikarus-trigger-group-remove">&times;</button>':''}</div>`).join(''));}
function readFilterTriggerGroups(){return $('#ikarus_flt_trigger_groups .ikarus-trigger-group').map(function(){return{trigger:$(this).find('.ikarus-flt-group-trigger').val()?.trim()||'',matchMode:$(this).find('.ikarus-flt-group-mode').val()||'OR'};}).get().filter(g=>g.trigger);}
function filterTriggerGroupsLabel(f){return normalizeFilterTriggerGroups(f).map(g=>`${g.trigger} (${g.matchMode})`).join(' AND ');}

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
                <div><b class="trigger-label">When:</b> ${esc(filterTriggerGroupsLabel(f))}</div>
                <div><b class="${f.action === 'remove' ? 'filter-label' : 'replace-label'}">${f.action === 'remove' ? '✂ Remove:' : f.action === 'append' ? '+ Append:' : '⇄ Replace:'}</b> ${esc((f.actionText || f.findText || '').substring(0, 80))}</div>
                ${f.action === 'replace' ? `<div><b class="replace-label">→</b> ${esc((f.actionText || '').substring(0, 80))}</div>` : ''}
                <div>Target: ${f.target || 'positive'} | <span class="scope-badge">${f.scope === 'char' ? '👤' : '🌐'}</span></div>
            </div>
        </div>`;
    }).join(''));
}

function addFilter() {
    const name = $('#ikarus_flt_name').val()?.trim();
    const triggerGroups = readFilterTriggerGroups();
    const trigger = triggerGroups[0]?.trigger || '';
    const matchMode = triggerGroups[0]?.matchMode || 'OR';
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
        trigger, matchMode, triggerGroups, action, actionText: actionText || '', findText: findText || '', target, enabled: true,
    });
    saveSettingsDebounced(); renderFilterList();
    $('#ikarus_flt_name, #ikarus_flt_action_text, #ikarus_flt_find_text').val('');
    renderFilterTriggerGroups();
    toastr.success(`Filter "${name || trigger}" added`);
}

function editFilter(id) {
    const es = s(); const f = es.filters.find(x => x.id === id); if (!f) return;
    $('#ikarus_flt_name').val(f.name); renderFilterTriggerGroups(normalizeFilterTriggerGroups(f));
    $('#ikarus_flt_action').val(f.action || 'remove');
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
                <span>&#128194; Global Replacements Manager</span>
                <button id="ikarus_manager_close" class="menu_button" title="Close">&#10005;</button>
            </div>
            <div class="ikarus-manager-body">
                <div class="ikarus-manager-sidebar">
                    <div class="ikarus-manager-folder-list" id="ikarus_folder_list"></div>
                    <div class="ikarus-manager-sidebar-bottom">
                        <div class="ikarus-manager-folder-add">
                            <input id="ikarus_folder_name" class="text_pole" placeholder="New folder..." />
                            <button id="ikarus_folder_create" class="menu_button" title="Create folder">+</button>
                        </div>
                        <div class="ikarus-manager-folder-add">
                            <input id="ikarus_cat_name" class="text_pole" placeholder="New category..." />
                            <button id="ikarus_cat_create" class="menu_button" title="Create category">+</button>
                        </div>
                    </div>
                </div>
                <div class="ikarus-manager-main">
                    <input id="ikarus_manager_search" class="text_pole" placeholder="Search by name or trigger..." />
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
        let html = `<div class="ikarus-folder-item ikarus-library-launch" data-folder="__library__"><span>Character Library</span><small>Reusable character sets</small></div>`;
        html += `<div class="ikarus-manager-nav-label">GLOBAL REPLACEMENTS</div>`;
        html += `<div class="ikarus-folder-item ${activeFolder === null ? 'active' : ''}" data-folder="__all__">All</div>`;
        html += `<div class="ikarus-folder-item ${activeFolder === '' ? 'active' : ''}" data-folder="__unfiled__">📄 Unfiled</div>`;

        // Render categories with nested folders
        for (const cat of categories) {
            const catFolders = folders.filter(f => (fc[f] || '') === cat);
            html += `<div class="ikarus-cat-header">
                <span class="ikarus-cat-toggle" data-cat="${esc(cat)}">📚 ${esc(cat)}</span>
                <button class="ikarus-cat-delete" data-cat="${esc(cat)}" title="Delete category">&#10005;</button>
            </div>`;
            html += `<div class="ikarus-cat-children" data-cat="${esc(cat)}">`;
            for (const f of catFolders) {
                html += `<div class="ikarus-folder-item ikarus-folder-nested ${activeFolder === f ? 'active' : ''}" data-folder="${esc(f)}">
                    <span>📁 ${esc(f)}</span>
                    <button class="ikarus-folder-delete" data-folder="${esc(f)}" title="Delete folder">&#10005;</button>
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
                        <button class="ikarus-folder-delete" data-folder="${esc(f)}" title="Delete folder">&#10005;</button>
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

        let html = `<div class="ikarus-mgr-toolbar"><button id="ikarus_mgr_add" class="menu_button">Add New</button><button id="ikarus_mgr_bulk" class="menu_button" style="margin-top:4px;">Bulk Import JSON</button></div>`;

        if (!filtered.length) {
            html += '<div style="text-align:center;opacity:0.4;padding:24px;">No replacements found.</div>';
            $('#ikarus_manager_cards').html(html);
            return;
        }
        for (const r of filtered) {
            const children = (es.replacements || []).filter(c => c.parentId === r.id);
            // Build selected folder option
            let selOpts = `<option value=""${!r.folder ? ' selected' : ''}>Unfiled</option>`;
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
                <div class="ikarus-mgr-replace"><b>🏷️</b> ${esc((r.replacement || '').substring(0, 120))}${(r.replacement || '').length > 120 ? '…' : ''}</div>
                ${r.caption && r.caption !== r.replacement ? `<div class="ikarus-mgr-replace"><b>💬</b> ${esc((r.caption || '').substring(0, 120))}${(r.caption || '').length > 120 ? '…' : ''}</div>` : ''}
                <div class="ikarus-mgr-meta">Mode: ${r.replaceMode === 'all' ? 'All' : 'First'} | P${r.priority || 0}${children.length ? ` | ${children.length} child(ren)` : ''} | Active: ${es.repFieldMode === 'caption' ? '💬' : '🏷️'}</div>
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
                <label>Tags (🏷️)</label><textarea class="text_pole mgr-ed-replacement" rows="2">${esc(r.replacement || '')}</textarea>
                <label>Caption (💬)</label><textarea class="text_pole mgr-ed-caption" rows="2">${esc(r.caption || '')}</textarea>
                <label>Krea 2 (K2)</label><textarea class="text_pole mgr-ed-krea2" rows="2">${esc(r.krea2 || '')}</textarea>
                <label>Dedupe tag (🔁)</label><input class="text_pole mgr-ed-short-tag" value="${esc(r.shortTag || '')}" placeholder="e.g. darkness \\(konosuba\\) — used for 2nd+ occurrences in 'First full' mode" />
                <label>Match</label>
                <select class="text_pole mgr-ed-match">
                    <option value="OR"${r.matchMode === 'OR' ? ' selected' : ''}>OR</option>
                    <option value="AND"${r.matchMode === 'AND' ? ' selected' : ''}>AND</option>
                    <option value="CHILD"${r.matchMode === 'CHILD' ? ' selected' : ''}>CHILD</option>
                </select>
                <label>Replace Mode</label>
                <select class="text_pole mgr-ed-mode">
                    <option value="first"${r.replaceMode === 'first' ? ' selected' : ''}>First</option>
                    <option value="all"${r.replaceMode === 'all' ? ' selected' : ''}>All</option>
                    <option value="first_full"${r.replaceMode === 'first_full' ? ' selected' : ''}>First full, rest dedupe</option>
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
        let folderSel = `<option value="">Unfiled</option>`;
        for (const f of folders) {
            folderSel += `<option value="${esc(f)}"${activeFolder && activeFolder === f ? ' selected' : ''}>${esc(f)}</option>`;
        }
        const existing = $('#ikarus_mgr_addform');
        if (existing.length) { existing.slideToggle(150); return; }
        const form = $(`<div id="ikarus_mgr_addform" class="ikarus-mgr-card" style="border-color:var(--SmartThemeQuoteColor,#e0a0ff);">
            <div class="ikarus-mgr-name" style="margin-bottom:6px;">âž• New Replacement</div>
            <div class="ikarus-mgr-edit-grid">
                <label>Name</label><input class="text_pole mgr-new-name" placeholder="e.g. Bloom(Winx)" />
                <label>Trigger</label><input class="text_pole mgr-new-trigger" placeholder="e.g. bloom, Bloom winx, bloom winx club" />
                <label>Tags (🏷️)</label><textarea class="text_pole mgr-new-replacement" rows="2" placeholder="e.g. &lt;lora:AnimaBloom:1&gt;Bloom,"></textarea>
                <label>Caption (💬)</label><textarea class="text_pole mgr-new-caption" rows="2" placeholder="Same as tags, or a descriptive caption"></textarea>
                <label>Krea 2 (K2)</label><textarea class="text_pole mgr-new-krea2" rows="2" placeholder="Krea 2-specific replacement (optional)"></textarea>
                <label>Match</label>
                <select class="text_pole mgr-new-match"><option value="OR">OR</option><option value="AND">AND</option><option value="CHILD">CHILD</option></select>
                <label>Priority</label><input class="text_pole mgr-new-priority" type="number" value="0" />
                <label>Folder</label><select class="text_pole mgr-new-folder">${folderSel}</select>
            </div>
            <div class="ikarus-mgr-edit-btns">
                <button class="menu_button" id="ikarus_mgr_addconfirm">âž• Add</button>
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
        if (f === '__library__') { closeGlobalManager(); openCharacterLibrary(); return; }
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
        r.caption = form.find('.mgr-ed-caption').val()?.trim() || r.caption || r.replacement;
        r.krea2 = form.find('.mgr-ed-krea2').val()?.trim() || r.krea2 || r.caption || r.replacement;
        r.shortTag = form.find('.mgr-ed-short-tag').val()?.trim() || '';
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
        const caption = $('#ikarus_mgr_addform .mgr-new-caption').val()?.trim();
        const krea2 = $('#ikarus_mgr_addform .mgr-new-krea2').val()?.trim();
        if (!trigger) { toastr.warning('Trigger is required'); return; }
        if (!replacement && !caption && !krea2) { toastr.warning('Tags, Caption, or Krea 2 text is required'); return; }
        es.replacements.push({
            id: uid(),
            name: $('#ikarus_mgr_addform .mgr-new-name').val()?.trim() || trigger,
            scope: 'global', charId: null,
            trigger,
            matchMode: $('#ikarus_mgr_addform .mgr-new-match').val() || 'OR',
            replacement: replacement || caption || '',
            caption: caption || replacement || krea2 || '',
            krea2: krea2 || caption || replacement || '',
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
    // Bulk import
    overlay.on('click', '#ikarus_mgr_bulk', function () {
        const existing = $('#ikarus_mgr_bulkform');
        if (existing.length) { existing.slideToggle(150); return; }
        const folders = es.repFolders || [];
        let folderSel = `<option value="">Unfiled</option>`;
        for (const f of folders) {
            folderSel += `<option value="${esc(f)}"${activeFolder && activeFolder === f ? ' selected' : ''}>${esc(f)}</option>`;
        }
        const form = $(`<div id="ikarus_mgr_bulkform" class="ikarus-mgr-card" style="border-color:var(--SmartThemeQuoteColor,#e0a0ff);">
            <div class="ikarus-mgr-name" style="margin-bottom:6px;">📦 Bulk Import — Paste JSON</div>
            <div class="ikarus-hint" style="font-size:10px;margin-bottom:6px;opacity:0.6;">
                Format: <code>{"key": {"aliases": [...], "tags": "...", "caption": "..."}}</code>
            </div>
            <textarea class="text_pole mgr-bulk-json" rows="8" placeholder='Paste JSON here...\n\nExample:\n{"asuna_sao": {"aliases": ["asuna", "yuuki asuna"], "tags": "asuna (sao), 1girl, ...", "caption": "asuna (sao), 1girl, ..."}}'></textarea>
            <div class="ikarus-mgr-edit-grid" style="grid-template-columns:auto 1fr; margin-top:6px;">
                <label>Scope</label>
                <select class="text_pole mgr-bulk-scope">
                    <option value="global">🌐 Global</option>
                    <option value="char">👤 Current Character</option>
                </select>
                <label>Folder</label><select class="text_pole mgr-bulk-folder">${folderSel}</select>
            </div>
            <div class="ikarus-mgr-edit-btns">
                <button class="menu_button" id="ikarus_mgr_bulkconfirm">📦 Import All</button>
                <button class="menu_button" id="ikarus_mgr_bulkcancel">Cancel</button>
            </div>
        </div>`);
        $('#ikarus_manager_cards .ikarus-mgr-toolbar').after(form);
    });
    // Bulk import — confirm
    overlay.on('click', '#ikarus_mgr_bulkconfirm', function () {
        const raw = $('#ikarus_mgr_bulkform .mgr-bulk-json').val()?.trim();
        const scope = $('#ikarus_mgr_bulkform .mgr-bulk-scope').val() || 'global';
        const folder = $('#ikarus_mgr_bulkform .mgr-bulk-folder').val() || '';
        const charId = scope === 'char' ? getCurrentCharId() : null;
        if (scope === 'char' && !charId) { toastr.warning('Select a character first'); return; }
        if (!raw) { toastr.warning('Paste JSON data first'); return; }
        let data;
        try { data = JSON.parse(raw); } catch (e) { toastr.error('Invalid JSON: ' + e.message); return; }
        if (typeof data !== 'object' || Array.isArray(data)) { toastr.error('JSON must be an object with named entries'); return; }
        let count = 0;
        for (const [key, entry] of Object.entries(data)) {
            if (!entry || typeof entry !== 'object') continue;
            const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
            const trigger = aliases.join(', ');
            const tags = entry.tags || '';
            const caption = entry.caption || tags;
            const krea2 = entry.krea2 || caption || tags;
            if (!trigger && !tags && !caption && !krea2) continue;
            es.replacements.push({
                id: uid(), name: key.replace(/_/g, ' '),
                scope, charId,
                trigger: trigger || key.replace(/_/g, ' '),
                matchMode: 'OR',
                replacement: tags,
                caption: caption,
                krea2: krea2,
                replaceMode: 'first', priority: 0,
                parentId: null, enabled: true,
                folder: scope === 'global' ? folder : '',
            });
            count++;
        }
        if (count) {
            saveSettingsDebounced(); renderManagerCards(); renderReplacementList();
            toastr.success(`${count} replacement(s) imported`);
            $('#ikarus_mgr_bulkform').slideUp(150, function () { $(this).remove(); });
        } else {
            toastr.warning('No valid entries found in JSON');
        }
    });
    // Bulk import — cancel
    overlay.on('click', '#ikarus_mgr_bulkcancel', function () {
        $('#ikarus_mgr_bulkform').slideUp(150, function () { $(this).remove(); });
    });
}

// ===========================================================================
// Independent Character Library ? reusable local replacement/filter bundles
// ===========================================================================
function openCharacterLibrary() {
    if ($('#ikarus_library_overlay').length) return;
    const es = s();
    const charId = getCurrentCharId();
    const charName = getCurrentCharName();
    const overlay = $(`
    <div id="ikarus_library_overlay" class="ikarus-manager-overlay">
      <div class="ikarus-manager-popup">
        <div class="ikarus-manager-header"><span>&#128218; Independent Character Library</span><button id="ikarus_library_close" class="menu_button">&#10005;</button></div>
        <div class="ikarus-manager-body">
          <div class="ikarus-manager-sidebar">
            <div class="ikarus-library-back"><button id="ikarus_library_back" class="menu_button">&#8592; Back to Global Manager</button></div>
            <div class="ikarus-manager-nav-label">CHARACTER FOLDERS</div>
            <div id="ikarus_library_folders" class="ikarus-manager-folder-list"></div>
            <div class="ikarus-manager-sidebar-bottom">
              <label class="ikarus-library-create-label">Create empty folder</label>
              <div class="ikarus-manager-folder-add"><input id="ikarus_library_name" class="text_pole" placeholder="e.g. Naruto universe" /><button id="ikarus_library_save" class="menu_button" title="Create folder">+</button></div>
              <div class="ikarus-hint">One folder can contain an entire reusable cast.</div>
            </div>
          </div>
          <div class="ikarus-manager-main"><div id="ikarus_library_details" class="ikarus-manager-cards"></div></div>
        </div>
      </div>
    </div>`);
    $('body').append(overlay);
    let selectedId = es.characterLibrary.folders[0]?.id || null;

    const clone = value => JSON.parse(JSON.stringify(value));
    function currentCharacterBundle(name) {
        if (!charId) return null;
        const localReplacements = (es.replacements || []).filter(r => r.scope === 'char' && r.charId === charId);
        const localFilters = (es.filters || []).filter(f => f.scope === 'char' && f.charId === charId);
        return {
            id: uid(), name: name || charName, createdAt: new Date().toISOString(),
            prefix: es.charPrefixes?.[charId] || '', prompt: clone(es.charPrompts?.[charId] || null),
            replacements: clone(localReplacements), filters: clone(localFilters),
        };
    }
    function renderFolders() {
        const folders = es.characterLibrary.folders || [];
        $('#ikarus_library_folders').html(folders.length ? folders.map(folder => `<div class="ikarus-folder-item ${folder.id === selectedId ? 'active' : ''}" data-id="${esc(folder.id)}"><span>&#128100; ${esc(folder.name)}</span><button class="ikarus-library-delete" data-id="${esc(folder.id)}" title="Delete library folder">&#10005;</button></div>`).join('') : '<div class="ikarus-cat-empty">No saved character folders.</div>');
    }
    function renderDetails() {
        const folder = (es.characterLibrary.folders || []).find(x => x.id === selectedId);
        if (!folder) { $('#ikarus_library_details').html('<div class="ikarus-library-empty"><h3>Character Library</h3><p>Create a universe or project folder on the left.</p><p>Then add reusable characters with Tags, Caption, and Krea 2 text.</p></div>'); return; }
        const reps = folder.replacements || [], filters = folder.filters || [];
        $('#ikarus_library_details').html(`
          <div class="ikarus-library-titlebar"><div><h3>${esc(folder.name)}</h3><div class="ikarus-mgr-meta">${reps.length} character(s) · ${filters.length} filter(s)</div></div><button id="ikarus_library_import" class="menu_button primary" ${charId ? '' : 'disabled'}>Import all into ${esc(charId ? charName : 'current card')}</button></div>
          <div class="ikarus-library-actions"><button id="ikarus_library_add_character" class="menu_button">+ Add character</button><button id="ikarus_library_remove_character" class="menu_button" ${reps.length ? '' : 'disabled'}>Remove character</button><button id="ikarus_library_overwrite" class="menu_button" ${charId ? '' : 'disabled'}>Replace folder with current card</button></div>
          <div id="ikarus_library_character_form"></div>
          <div class="ikarus-library-list">${reps.length ? reps.map(r => `<div class="ikarus-mgr-card"><div class="ikarus-mgr-name">${esc(r.name || 'Unnamed character')}</div><div class="ikarus-mgr-trigger"><b>Trigger:</b> ${esc(r.trigger || '')}</div><div class="ikarus-mgr-replace"><b>Tags:</b> ${esc((r.replacement || '').slice(0,160))}</div>${r.caption ? `<div class="ikarus-mgr-replace"><b>Caption:</b> ${esc((r.caption || '').slice(0,160))}</div>` : ''}${r.krea2 ? `<div class="ikarus-mgr-replace"><b>Krea 2:</b> ${esc((r.krea2 || '').slice(0,160))}</div>` : ''}</div>`).join('') : '<div class="ikarus-library-empty compact"><p>This folder has no characters yet.</p><p>Click <b>Add character</b> above.</p></div>'}</div>
          ${filters.map(f => `<div class="ikarus-mgr-card"><b>${esc(f.name || 'Unnamed filter')}</b><div>Filter trigger: ${esc(f.trigger || '')}</div></div>`).join('')}`);
    }
    function importBundle(folder) {
        if (!charId) { toastr.warning('Select a character first'); return; }
        const idMap = new Map();
        const rules = clone(folder.replacements || []);
        for (const r of rules) idMap.set(r.id, uid());
        for (const r of rules) { r.id = idMap.get(r.id); r.parentId = r.parentId ? (idMap.get(r.parentId) || null) : null; r.scope = 'char'; r.charId = charId; r.folder = ''; }
        const filters = clone(folder.filters || []).map(f => ({ ...f, id: uid(), scope: 'char', charId }));
        es.replacements.push(...rules); es.filters.push(...filters);
        if (folder.prefix) es.charPrefixes[charId] = folder.prefix;
        if (folder.prompt) es.charPrompts[charId] = clone(folder.prompt);
        saveSettingsDebounced(); loadCharPrefix(); loadCharPrompt(); renderReplacementList(); renderFilterList();
        toastr.success(`Imported ${rules.length} replacement(s) and ${filters.length} filter(s) into ${charName}`);
    }
    renderFolders(); renderDetails();
    overlay.on('click', '#ikarus_library_close', () => overlay.remove());
    overlay.on('click', '#ikarus_library_back', () => { overlay.remove(); openGlobalManager(); });
    overlay.on('click', e => { if ($(e.target).is('#ikarus_library_overlay')) overlay.remove(); });
    overlay.on('click', '.ikarus-folder-item', function () { selectedId = $(this).data('id'); renderFolders(); renderDetails(); });
    overlay.on('click', '.ikarus-library-delete', function (e) { e.stopPropagation(); const id=$(this).data('id'); const folder=es.characterLibrary.folders.find(x=>x.id===id); if (!folder || !confirm(`Delete library folder "${folder.name}"? This does not affect any character card.`)) return; es.characterLibrary.folders=es.characterLibrary.folders.filter(x=>x.id!==id); selectedId=es.characterLibrary.folders[0]?.id||null; saveSettingsDebounced(); renderFolders(); renderDetails(); });
    overlay.on('click', '#ikarus_library_save', function () { const name=$('#ikarus_library_name').val()?.trim(); if (!name) { toastr.warning('Enter a folder name'); return; } if (es.characterLibrary.folders.some(x => x.name.toLowerCase() === name.toLowerCase())) { toastr.warning('Folder already exists'); return; } const folder={id:uid(),name,createdAt:new Date().toISOString(),prefix:'',prompt:null,replacements:[],filters:[]}; es.characterLibrary.folders.push(folder); selectedId=folder.id; $('#ikarus_library_name').val(''); saveSettingsDebounced(); renderFolders(); renderDetails(); toastr.success(`Created "${name}"`); });
    overlay.on('click', '#ikarus_library_overwrite', function () { const folder=es.characterLibrary.folders.find(x=>x.id===selectedId); if (!folder || !charId) return; if (!confirm(`Replace saved contents of "${folder.name}" with ${charName}'s current local rules?`)) return; const bundle=currentCharacterBundle(folder.name); Object.assign(folder,bundle,{id:folder.id}); saveSettingsDebounced(); renderDetails(); toastr.success(`Updated "${folder.name}"`); });
    overlay.on('click', '#ikarus_library_import', function () { const folder=es.characterLibrary.folders.find(x=>x.id===selectedId); if (folder) importBundle(folder); });
    overlay.on('click', '#ikarus_library_add_character', function () {
        $('#ikarus_library_character_form').html(`<div class="ikarus-mgr-card" style="border-color:var(--SmartThemeQuoteColor,#e0a0ff);"><div class="ikarus-mgr-name">Add a character to this library folder</div><div class="ikarus-mgr-edit-grid"><label>Character name</label><input class="text_pole lib-char-name" placeholder="e.g. Naruto Uzumaki" /><label>Trigger words</label><input class="text_pole lib-char-trigger" placeholder="e.g. naruto, naruto uzumaki" /><label>Tags</label><textarea class="text_pole lib-char-tags" rows="2" placeholder="Danbooru-style replacement"></textarea><label>Caption</label><textarea class="text_pole lib-char-caption" rows="2" placeholder="Natural-language replacement"></textarea><label>Krea 2</label><textarea class="text_pole lib-char-krea2" rows="2" placeholder="Krea 2-specific replacement"></textarea></div><div class="ikarus-mgr-edit-btns"><button id="ikarus_library_add_character_confirm" class="menu_button">Add character</button><button id="ikarus_library_character_cancel" class="menu_button">Cancel</button></div></div>`);
    });
    overlay.on('click', '#ikarus_library_character_cancel', function () { $('#ikarus_library_character_form').empty(); });
    overlay.on('click', '#ikarus_library_add_character_confirm', function () {
        const folder = es.characterLibrary.folders.find(x => x.id === selectedId); if (!folder) return;
        const form = $('#ikarus_library_character_form');
        const name = form.find('.lib-char-name').val()?.trim(); const trigger = form.find('.lib-char-trigger').val()?.trim();
        const tags = form.find('.lib-char-tags').val()?.trim(); const caption = form.find('.lib-char-caption').val()?.trim(); const krea2 = form.find('.lib-char-krea2').val()?.trim();
        if (!name) { toastr.warning('Character name is required'); return; }
        if (!trigger) { toastr.warning('Trigger words are required'); return; }
        if (!tags && !caption && !krea2) { toastr.warning('Enter Tags, Caption, or Krea 2 text'); return; }
        if (!Array.isArray(folder.replacements)) folder.replacements = [];
        folder.replacements.push({ id: uid(), name, trigger, matchMode: 'OR', replacement: tags || caption || krea2, caption: caption || tags || krea2, krea2: krea2 || caption || tags, shortTag: '', replaceMode: 'first', priority: 0, parentId: null, enabled: true, scope: 'char', charId: null, folder: '' });
        saveSettingsDebounced(); renderDetails(); toastr.success(`Added ${name} to ${folder.name}`);
    });
    overlay.on('click', '#ikarus_library_remove_character', function () {
        const folder = es.characterLibrary.folders.find(x => x.id === selectedId); if (!folder) return;
        const reps = folder.replacements || [];
        $('#ikarus_library_character_form').html(`<div class="ikarus-mgr-card" style="border-color:var(--SmartThemeQuoteColor,#e0a0ff);"><div class="ikarus-mgr-name">Remove a character</div><label>Choose character</label><select id="ikarus_library_remove_select" class="text_pole">${reps.map(r => `<option value="${esc(r.id)}">${esc(r.name || r.trigger || 'Unnamed character')}</option>`).join('')}</select><div class="ikarus-mgr-edit-btns"><button id="ikarus_library_remove_character_confirm" class="menu_button">Remove selected character</button><button id="ikarus_library_character_cancel" class="menu_button">Cancel</button></div></div>`);
    });
    overlay.on('click', '#ikarus_library_remove_character_confirm', function () {
        const folder = es.characterLibrary.folders.find(x => x.id === selectedId); if (!folder) return;
        const id = $('#ikarus_library_remove_select').val(); const rule = (folder.replacements || []).find(r => r.id === id); if (!rule) return;
        if (!confirm(`Remove "${rule.name || rule.trigger}" from library folder "${folder.name}"?`)) return;
        folder.replacements = folder.replacements.filter(r => r.id !== id && r.parentId !== id);
        saveSettingsDebounced(); renderDetails(); toastr.success('Character removed from library folder');
    });
}

function closeGlobalManager() {
    $('#ikarus_manager_overlay').remove();
}

// ==========================================================================
// PROCESSING: Apply Replacements (in-place, with children priority)
// ==========================================================================
function applyReplacements(text) {
    if (s().replacementsEnabled === false) return text;
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
            if (!replacementConditionsMatch(result, child)) continue;

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

function triggerGroupMatches(lower,g){const w=String(g.trigger||'').split(',').map(k=>k.trim().toLowerCase()).filter(Boolean);if(!w.length)return false;const c=w.filter(x=>lower.includes(x)).length;if(g.matchMode==='AND')return c===w.length;if(g.matchMode==='XOR')return c===1;if(g.matchMode==='NOR')return c===0;return c>0;}
function triggerMatches(text,rule){const lower=String(text||'').toLowerCase();const groups=Array.isArray(rule?.triggerGroups)&&rule.triggerGroups.length?(s().replacements||[]).includes(rule)?normalizeReplacementTriggerGroups(rule):normalizeFilterTriggerGroups(rule):[{trigger:rule?.trigger,matchMode:rule?.matchMode||'OR'}];return groups.every((g,i)=>g.matchMode==='CHILD'&&i===0?true:triggerGroupMatches(lower,g));}
function replacementConditionsMatch(text,rule){return normalizeReplacementTriggerGroups(rule).slice(1).every(g=>triggerGroupMatches(String(text||'').toLowerCase(),g));}

function doReplace(text, rule) {
    const keywords = rule.trigger.split(',').map(k => k.trim()).filter(Boolean);
    // Use tags or caption based on the global toggle
    const mode = s().repFieldMode;
    const activeText = mode === 'caption' ? (rule.caption || rule.replacement || rule.krea2 || '')
        : mode === 'krea2' ? (rule.krea2 || rule.caption || rule.replacement || '')
            : (rule.replacement || rule.caption || rule.krea2 || '');
    let result = text;
    for (const kw of keywords) {
        const escaped = escRegex(kw);
        if (rule.replaceMode === 'first_full') {
            // First occurrence → full replacement text
            result = result.replace(new RegExp(`\\b${escaped}\\b`, 'i'), activeText.trim());
            // Remaining occurrences → short dedupe tag (or just the keyword with disambiguation if no shortTag set)
            const dedupeText = (rule.shortTag || kw).trim();
            result = result.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), dedupeText);
        } else {
            const flags = rule.replaceMode === 'all' ? 'gi' : 'i';
            result = result.replace(new RegExp(`\\b${escaped}\\b`, flags), activeText.trim());
        }
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

    const prefix = getCharPrefix();
    if (prefix) {
        p = joinPrompt(prefix, p);
    }

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

// Prompts generated by this extension are processed before calling /sd. The
// native SD event still fires, so remember them briefly to avoid double passes.
const _processedSdPrompts = new Set();

function markProcessedSdPrompt(prompt) {
    const key = String(prompt || '');
    if (!key) return;
    _processedSdPrompts.add(key);
    setTimeout(() => _processedSdPrompts.delete(key), 30000);
}

function handleGlobalSdPromptProcessing(eventData) {
    try {
        const es = s();
        if (!es.filterNativeSd) return;
        if (!eventData || typeof eventData.prompt !== 'string') return;

        const originalPrompt = eventData.prompt;
        if (_processedSdPrompts.delete(originalPrompt)) {
            return;
        }

        const processed = processPrompt(originalPrompt, '');
        if (processed.prompt !== originalPrompt) {
            eventData.prompt = processed.prompt;
            console.log(`[${EXT}] Global /sd prompt filtered before image generation`);
        }
    } catch (error) {
        console.error(`[${EXT}] Global /sd prompt filter error:`, error);
    }
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

function getExtensionPromptRole() {
    switch (s().promptInjection?.position) {
        case 'deep_user': return extension_prompt_roles.USER;
        case 'deep_assistant': return extension_prompt_roles.ASSISTANT;
        default: return extension_prompt_roles.SYSTEM;
    }
}

function getPromptInjectionText() {
    let promptText = s().promptInjection?.prompt || '';
    const charPrompt = getCharPromptText();
    promptText = promptText.replace(/\{CharacterPersonalised-prompt\}/gi, charPrompt);
    return { promptText, charPrompt };
}

function syncPromptInjection() {
    try {
        const es = s();
        const enabled = es.promptInjection?.enabled && es.insertType !== INSERT_TYPE.DISABLED;
        const isSeparate = es.generationMode === 'separate' || es.generationMode === 'standalone';
        const isAppendUser = es.promptInjection?.position === 'append_user';
        const isMacro = es.promptInjection?.position === 'macro';
        const { promptText, charPrompt } = enabled ? getPromptInjectionText() : { promptText: '', charPrompt: '' };
        const depth = Number(es.promptInjection?.depth || 0);

        if (isSeparate) {
            setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
            console.log(`[${EXT}] Separate mode: prompt injection cleared (will use second API call)`);
        } else if (isMacro) {
            // Clear native prompt — macro mode handles injection via {{IkarusAutoImage-prompt}} macro replacement
            setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
            console.log(`[${EXT}] Macro mode ${enabled ? 'active' : 'cleared'}: prompt will be injected via {{IkarusAutoImage-prompt}} macro`);
        } else if (isAppendUser) {
            // Clear native prompt — append_user mode handles injection via GENERATION_STARTED
            setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
            console.log(`[${EXT}] Append-to-user mode ${enabled ? 'active' : 'cleared'}: charPrompt=${charPrompt ? 'yes' : 'none'}`);
        } else {
            setExtensionPrompt(PROMPT_KEY, promptText, extension_prompt_types.IN_CHAT, depth, false, getExtensionPromptRole());
            console.log(`[${EXT}] Native prompt ${enabled ? 'registered' : 'cleared'}: depth=${depth}, charPrompt=${charPrompt ? 'yes' : 'none'}`);
        }
    } catch (error) { console.error(`[${EXT}] Native prompt sync error:`, error); }
}

// --- Append-to-User-Message mode ---
// Stores the original message text so we can restore after generation
let _appendUserOriginal = null;
let _appendUserMesIdx = -1;
let _isAwaitingNewMessage = false;

function appendPromptToLastUserMessage() {
    const es = s();
    if (!es || es.insertType === INSERT_TYPE.DISABLED) return;
    if (es.generationMode === 'separate' || es.generationMode === 'standalone') return;
    if (es.promptInjection?.position !== 'append_user') return;
    if (!es.promptInjection?.enabled) return;

    const { promptText } = getPromptInjectionText();
    if (!promptText.trim()) return;

    try {
        const context = getContext();
        // Find the last user message
        for (let i = context.chat.length - 1; i >= 0; i--) {
            if (context.chat[i].is_user) {
                _appendUserMesIdx = i;
                _appendUserOriginal = context.chat[i].mes;
                // Append the prompt text after the user's message with a separator
                context.chat[i].mes = `${_appendUserOriginal}\n\n${promptText}`;
                console.log(`[${EXT}] Appended prompt to user message #${i}`);
                return;
            }
        }
    } catch (error) {
        console.error(`[${EXT}] Append-to-user error:`, error);
    }
}

function restoreOriginalUserMessage() {
    if (_appendUserOriginal === null || _appendUserMesIdx < 0) return;
    try {
        const context = getContext();
        if (context.chat[_appendUserMesIdx]?.is_user) {
            context.chat[_appendUserMesIdx].mes = _appendUserOriginal;
            console.log(`[${EXT}] Restored original user message #${_appendUserMesIdx}`);
        }
    } catch (error) {
        console.error(`[${EXT}] Restore user message error:`, error);
    } finally {
        _appendUserOriginal = null;
        _appendUserMesIdx = -1;
    }
}

eventSource.on(event_types.GENERATION_STARTED, () => {
    _isAwaitingNewMessage = true;
    syncPromptInjection();
    appendPromptToLastUserMessage();
});
eventSource.on(event_types.GENERATION_ENDED, () => { restoreOriginalUserMessage(); });
eventSource.on(event_types.GENERATION_STOPPED, () => { _isAwaitingNewMessage = false; restoreOriginalUserMessage(); });
eventSource.on(event_types.CHAT_LOADED, syncPromptInjection);
eventSource.on(event_types.APP_READY, syncPromptInjection);
if (event_types.SD_PROMPT_PROCESSING) {
    eventSource.on(event_types.SD_PROMPT_PROCESSING, handleGlobalSdPromptProcessing);
} else {
    console.warn(`[${EXT}] SD_PROMPT_PROCESSING event not available; native /sd prompts cannot be globally filtered on this SillyTavern build.`);
}

// ==========================================================================
// Character change detection — auto-refresh when switching cards
// ==========================================================================
eventSource.on(event_types.CHAT_CHANGED, function () {
    _isAwaitingNewMessage = false;
    console.log(`[${EXT}] Chat changed — refreshing character-specific UI`);
    migrateCharKeys();
    loadCharPrompt();
    loadCharPrefix();
    syncPromptInjection();
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
    renderStandaloneGallery();
});

// ==========================================================================
// Message Handler — detect → process → generate
// ==========================================================================
eventSource.on(event_types.MESSAGE_RECEIVED, handleIncomingMessage);

function getImagePromptMatches(text, regexPattern) {
    const found = [];
    const seen = new Set();
    const addMatch = (full, prompt) => {
        if (!full || typeof prompt !== 'string' || seen.has(full)) return;
        seen.add(full);
        found.push({ full, prompt });
    };

    try {
        const configuredRegex = regexFromString(regexPattern);
        if (configuredRegex.global) {
            for (const match of text.matchAll(configuredRegex)) addMatch(match?.[0], match?.[1]);
        } else {
            const match = text.match(configuredRegex);
            addMatch(match?.[0], match?.[1]);
        }
    } catch (error) {
        console.warn(`[${EXT}] Invalid configured image regex, using fallback matcher:`, error);
    }

    FALLBACK_PIC_REGEX.lastIndex = 0;
    for (const match of text.matchAll(FALLBACK_PIC_REGEX)) addMatch(match?.[0], match?.[1]);
    return found;
}

/**
 * Normalizes malformed pic prompt tags to the correct [pic prompt="..."] format.
 * Catches: *pic prompt="..."*, (pic prompt="..."), {pic prompt="..."}, <pic prompt="...">,
 *          and bare/unwrapped pic prompt="..." with no brackets at all.
 */
function normalizePicPrompts(text) {
    // Step 1: Fix wrapped variants — *pic..*, (pic..), {pic..}, <pic..>
    // This regex matches any opening wrapper char(s), then pic prompt="...", then closing wrapper char(s)
    let result = text.replace(/(?:[*_~`]+\s*|[(\[{<]\s*)pic\s+prompt\s*=\s*"([^"]*?)"\s*(?:[*_~`]+|[)\]}>])/gi,
        (_match, prompt) => `[pic prompt="${prompt}"]`
    );
    // Step 2: Catch completely bare/unwrapped: pic prompt="..." sitting alone (not already inside brackets)
    result = result.replace(/(?<![[\w])pic\s+prompt\s*=\s*"([^"]*?)"(?![^\s\]]*\])/gi,
        (_match, prompt) => `[pic prompt="${prompt}"]`
    );
    return result;
}

function populateProfileDropdown() {
    const $select = $('#ikarus_separate_profile');
    if (!$select.length) return;
    const st = getContext();
    $select.empty();
    $select.append($('<option></option>').val('').text('Same as Current'));
    try {
        const cmEnabled = !st.extensionSettings?.disabledExtensions?.includes('connection-manager');
        const profiles = cmEnabled && st.extensionSettings?.connectionManager?.profiles;
        if (Array.isArray(profiles)) {
            for (const p of profiles) {
                $select.append($('<option></option>').val(p.id).text(p.name));
            }
        }
    } catch (e) { console.warn(`[${EXT}] Could not load connection profiles:`, e); }
    $select.val(s().separateProfile || '');
    const $standaloneProfile = $('#ikarus_standalone_profile');
    if ($standaloneProfile.length) {
        $standaloneProfile.html($select.html());
        $standaloneProfile.val(s().standalone?.profile || '');
    }
    const $windowProfile = $('#ikarus_window_profile');
    if ($windowProfile.length) {
        $windowProfile.html($select.html());
        $windowProfile.val(s().standalone?.profile || '');
    }
}

async function sendRequestWithNativeFallback(context, profileId, messages, options, rawPrompt, label) {
    if (context.ConnectionManagerRequestService?.sendRequest) {
        try {
            return await context.ConnectionManagerRequestService.sendRequest(profileId, messages, undefined, options);
        } catch (error) {
            console.warn(`[${EXT}] ${label}: Connection Manager unsupported/failed; using generateRaw`, error);
        }
    }
    return await generateRaw(rawPrompt, '', false, false);
}

async function handleSeparateMode() {
    const es = s();
    if (!es || es.insertType === INSERT_TYPE.DISABLED) return;
    const context = getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user || !es.promptInjection?.regex) return;

    const mesIdx = context.chat.length - 1;
    const { promptText } = getPromptInjectionText();
    if (!promptText.trim()) {
        console.warn(`[${EXT}] Separate mode: no prompt template configured, skipping`);
        return;
    }

    const contextSize = Number(es.separateContextSize ?? 1);
    const aiMessages = context.chat.filter(m => !m.is_user && m.mes);
    const targetMessage = message.mes;

    let userPrompt;
    if (contextSize === 1) {
        userPrompt = `Re-output the following roleplay message exactly as-is, but with [pic prompt="..."] image tags inserted at contextually appropriate places within the text. Do not modify, rephrase, or remove any of the original text. Only add image tags.\n\n${targetMessage}`;
    } else {
        const contextMessages = contextSize === 0
            ? aiMessages.slice(0, -1)
            : aiMessages.slice(-contextSize).slice(0, -1);
        const contextBlock = contextMessages.map(m => m.mes).join('\n\n---\n\n');
        userPrompt = `Below are recent roleplay messages for context, followed by the TARGET MESSAGE. Use the context to understand the scene, but ONLY re-output the TARGET MESSAGE with [pic prompt="..."] image tags inserted at contextually appropriate places. Do not output the context messages. Do not modify, rephrase, or remove any of the target message's original text. Only add image tags.\n\n<context>\n${contextBlock}\n</context>\n\n<target_message>\n${targetMessage}\n</target_message>`;
    }

    const systemPrompt = promptText;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    const profileId = es.separateProfile || '';

    let waitToast = null;
    try {
        waitToast = toastr.info('Separate mode: waiting for image prompt API call...', 'Ikarus', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });

        let result = '';
        const st = context;
        if (st.ConnectionManagerRequestService && st.ConnectionManagerRequestService.sendRequest) {
            console.log(`[${EXT}] Separate mode: using ConnectionManagerRequestService (profile=${profileId || '<current>'})`);
            const createGenerator = await sendRequestWithNativeFallback(
                st, profileId, messages, { stream: false }, `${systemPrompt}

${userPrompt}`, 'Separate mode',
            );
            if (typeof createGenerator === 'function') {
                const generator = createGenerator();
                for await (const chunk of generator) {
                    if (chunk && chunk.text !== undefined) result = chunk.text;
                }
            } else if (createGenerator && typeof createGenerator === 'object') {
                result = createGenerator.content || createGenerator.text || String(createGenerator);
            }
        } else {
            console.log(`[${EXT}] Separate mode: ConnectionManagerRequestService unavailable, using generateRaw`);
            const rawPrompt = `${systemPrompt}\n\n${userPrompt}`;
            result = await generateRaw(rawPrompt, '', false, false);
        }

        if (!result || !result.trim()) {
            console.warn(`[${EXT}] Separate mode: empty response from second API call`);
            if (waitToast) toastr.clear(waitToast);
            toastr.warning('Separate mode: received empty response');
            return;
        }

        if (es.autoFixPicFormat) {
            result = normalizePicPrompts(result);
        }

        message.mes = result;
        updateMessageBlock(mesIdx, message);
        await context.saveChat();

        const matches = getImagePromptMatches(message.mes, es.promptInjection.regex);
        if (!matches.length) {
            console.log(`[${EXT}] Separate mode: no image prompts found in rewritten message`);
            if (waitToast) toastr.clear(waitToast);
            toastr.info('Separate mode: no image prompts were generated');
            return;
        }

        toastr.info(`Generating ${matches.length} image(s)...`);
        if (!message.extra) message.extra = {};
        if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
        if (message.extra.image && !message.extra.image_swipes.includes(message.extra.image)) message.extra.image_swipes.push(message.extra.image);

        for (const match of matches) {
            let imgPrompt = match.prompt;
            if (!imgPrompt.trim()) continue;

            const processed = processPrompt(imgPrompt, '');
            imgPrompt = processed.prompt;
            markProcessedSdPrompt(imgPrompt);

            const sdResult = await SlashCommandParser.commands['sd'].callback(
                { quiet: es.insertType === INSERT_TYPE.NEW_MESSAGE ? 'false' : 'true' }, imgPrompt);

            if (es.insertType === INSERT_TYPE.INLINE && typeof sdResult === 'string' && sdResult.trim()) {
                message.extra.image_swipes.push(sdResult); message.extra.image = sdResult;
                message.extra.title = imgPrompt; message.extra.inline_image = true;
                const messageElement = $(`.mes[mesid="${mesIdx}"]`);
                appendMediaToMessage(message, messageElement); await context.saveChat();
            } else if (es.insertType === INSERT_TYPE.REPLACE && typeof sdResult === 'string' && sdResult.trim()) {
                const tag = match.full; if (!tag) continue;
                message.mes = message.mes.replace(tag, `<img src="${esc(sdResult)}">`);
                updateMessageBlock(mesIdx, message);
                await eventSource.emit(event_types.MESSAGE_UPDATED, mesIdx); await context.saveChat();
            }
        }

        if (es.autoClean) {
            try {
                const cleanPattern = es.promptInjection.regex.replace(/^\/|\/[gimsuy]*$/g, '');
                if (cleanTagsFromMessage(message, cleanPattern)) {
                    await context.saveChat();
                    console.log(`[${EXT}] Auto-cleaned remaining tags from message`);
                }
            } catch (e) { console.error(`[${EXT}] Auto-clean error:`, e); }
        }

        if (waitToast) toastr.clear(waitToast);
        toastr.success(`${matches.length} image(s) generated via separate mode`);
    } catch (error) {
        if (waitToast) toastr.clear(waitToast);
        toastr.error(`Separate mode error: ${error}`);
        console.error(`[${EXT}] Separate mode error:`, error);
    }
}

// ==========================================================================
// Manual Rescan — trigger image processing on last N AI messages on demand
// ==========================================================================
async function handleManualRescan() {
    const es = s();
    const insertType = es?.insertType;
    if (!insertType || insertType === INSERT_TYPE.DISABLED) {
        toastr.warning('Enable an Insert Mode first (Inline, Replace, or New Message)');
        return;
    }

    const count = parseInt($('#ikarus_manual_rescan_count').val()) || 1;
    const context = getContext();
    const isSeparateMode = es.generationMode === 'separate';

    // Collect last N AI messages from chat
    const aiMessages = [];
    for (let i = context.chat.length - 1; i >= 0 && aiMessages.length < count; i--) {
        if (!context.chat[i].is_user && context.chat[i].mes) {
            aiMessages.push({ index: i, message: context.chat[i] });
        }
    }

    if (!aiMessages.length) {
        toastr.warning('No AI messages found to rescan');
        return;
    }

    // Process in chronological order (oldest first)
    aiMessages.reverse();

    let waitToast = null;
    const generationsQueue = [];

    try {
        waitToast = toastr.info(
            `Manual rescan: processing text for ${aiMessages.length} message(s) in ${isSeparateMode ? 'Separate' : 'Together'} mode...`,
            'Ikarus', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }
        );

        // --- Pass 1: Text processing & Tag injection ---
        for (const { index: mesIdx, message } of aiMessages) {
            if (isSeparateMode) {
                // Separate mode API call to rewrite message with injected [pic] tags
                const { promptText } = getPromptInjectionText();
                if (!promptText.trim()) {
                    console.warn(`[${EXT}] Manual rescan: no prompt template configured, skipping message #${mesIdx}`);
                    continue;
                }

                const contextSize = Number(es.separateContextSize ?? 1);
                const allAiMsgs = context.chat.filter(m => !m.is_user && m.mes);
                const targetMessage = message.mes;

                let userPrompt;
                if (contextSize === 1) {
                    userPrompt = `Re-output the following roleplay message exactly as-is, but with [pic prompt="..."] image tags inserted at contextually appropriate places within the text. Do not modify, rephrase, or remove any of the original text. Only add image tags.\n\n${targetMessage}`;
                } else {
                    const currentMsgIdx = allAiMsgs.indexOf(message);
                    const contextMessages = contextSize === 0
                        ? allAiMsgs.filter((_, i) => i < currentMsgIdx)
                        : allAiMsgs.filter((_, i) => i < currentMsgIdx).slice(-contextSize + 1);
                    const contextBlock = contextMessages.map(m => m.mes).join('\n\n---\n\n');
                    userPrompt = `Below are recent roleplay messages for context, followed by the TARGET MESSAGE. Use the context to understand the scene, but ONLY re-output the TARGET MESSAGE with [pic prompt="..."] image tags inserted at contextually appropriate places. Do not output the context messages. Do not modify, rephrase, or remove any of the target message's original text. Only add image tags.\n\n<context>\n${contextBlock}\n</context>\n\n<target_message>\n${targetMessage}\n</target_message>`;
                }

                const systemPrompt = promptText;
                const messages = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ];

                const profileId = es.separateProfile || '';
                let result = '';
                const st = context;

                if (st.ConnectionManagerRequestService && st.ConnectionManagerRequestService.sendRequest) {
                    console.log(`[${EXT}] Manual rescan (separate): using ConnectionManagerRequestService (profile=${profileId || '<current>'})`);
                    const createGenerator = await sendRequestWithNativeFallback(
                        st, profileId, messages, { stream: false }, `${systemPrompt}

${userPrompt}`, 'Manual rescan',
                    );
                    if (typeof createGenerator === 'function') {
                        const generator = createGenerator();
                        for await (const chunk of generator) {
                            if (chunk && chunk.text !== undefined) result = chunk.text;
                        }
                    } else if (createGenerator && typeof createGenerator === 'object') {
                        result = createGenerator.content || createGenerator.text || String(createGenerator);
                    }
                } else {
                    console.log(`[${EXT}] Manual rescan (separate): using generateRaw`);
                    const rawPrompt = `${systemPrompt}\n\n${userPrompt}`;
                    result = await generateRaw(rawPrompt, '', false, false);
                }

                if (!result || !result.trim()) {
                    console.warn(`[${EXT}] Manual rescan: empty response for message #${mesIdx}`);
                    continue;
                }

                if (es.autoFixPicFormat) {
                    result = normalizePicPrompts(result);
                }

                message.mes = result;
                updateMessageBlock(mesIdx, message);
                await context.saveChat();
            } else {
                // Together mode: auto-fix if enabled
                if (es.autoFixPicFormat) {
                    const fixed = normalizePicPrompts(message.mes);
                    if (fixed !== message.mes) {
                        message.mes = fixed;
                        updateMessageBlock(mesIdx, message);
                        await context.saveChat();
                    }
                }
            }

            // Extract matches to process in Pass 2
            const matches = getImagePromptMatches(message.mes, es.promptInjection.regex);
            if (matches.length > 0) {
                generationsQueue.push({ mesIdx, message, matches });
            }
        }

        // --- Text rewrite completed: clear waitToast immediately ---
        if (waitToast) {
            toastr.clear(waitToast);
            waitToast = null;
        }

        if (generationsQueue.length === 0) {
            toastr.info('Manual rescan complete: no image prompts found.');
            return;
        }

        // --- Pass 2: Image generation pass ---
        let totalImages = 0;
        for (const { mesIdx, message, matches } of generationsQueue) {
            if (!message.extra) message.extra = {};
            if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
            if (message.extra.image && !message.extra.image_swipes.includes(message.extra.image)) {
                message.extra.image_swipes.push(message.extra.image);
            }

            for (const match of matches) {
                let imgPrompt = match.prompt;
                if (!imgPrompt.trim()) continue;

                const processed = processPrompt(imgPrompt, '');
                imgPrompt = processed.prompt;
                markProcessedSdPrompt(imgPrompt);

                const sdResult = await SlashCommandParser.commands['sd'].callback(
                    { quiet: insertType === INSERT_TYPE.NEW_MESSAGE ? 'false' : 'true' }, imgPrompt);

                if (insertType === INSERT_TYPE.INLINE && typeof sdResult === 'string' && sdResult.trim()) {
                    message.extra.image_swipes.push(sdResult);
                    message.extra.image = sdResult;
                    message.extra.title = imgPrompt;
                    message.extra.inline_image = true;
                    const messageElement = $(`.mes[mesid="${mesIdx}"]`);
                    appendMediaToMessage(message, messageElement);
                    await context.saveChat();
                } else if (insertType === INSERT_TYPE.REPLACE && typeof sdResult === 'string' && sdResult.trim()) {
                    const tag = match.full;
                    if (!tag) continue;
                    message.mes = message.mes.replace(tag, `<img src="${esc(sdResult)}">`);
                    updateMessageBlock(mesIdx, message);
                    await eventSource.emit(event_types.MESSAGE_UPDATED, mesIdx);
                    await context.saveChat();
                }
                totalImages++;
            }

            // Auto-clean if enabled
            if (es.autoClean) {
                try {
                    const cleanPattern = es.promptInjection.regex.replace(/^\/|\/[gimsuy]*$/g, '');
                    if (cleanTagsFromMessage(message, cleanPattern)) {
                        await context.saveChat();
                        console.log(`[${EXT}] Manual rescan: auto-cleaned message #${mesIdx}`);
                    }
                } catch (e) { console.error(`[${EXT}] Manual rescan auto-clean error:`, e); }
            }
        }

        if (totalImages > 0) {
            toastr.success(`Manual rescan complete: ${totalImages} image(s) generated.`);
        } else {
            toastr.info('Manual rescan complete: no images were generated.');
        }

    } catch (error) {
        if (waitToast) toastr.clear(waitToast);
        toastr.error(`Manual rescan error: ${error}`);
        console.error(`[${EXT}] Manual rescan error:`, error);
    }
}

async function handleIncomingMessage() {
    if (!_isAwaitingNewMessage) return;
    _isAwaitingNewMessage = false;

    const es = s();
    if (!es || es.insertType === INSERT_TYPE.DISABLED) return;

    if (es.generationMode === 'standalone') {
        // Guard against stale/spurious triggers (e.g. switching chats or cards).
        // Only auto-generate for a genuine, freshly received AI message.
        if (!es.standalone.auto) return;
        const context = getContext();
        const message = context.chat[context.chat.length - 1];
        if (!message || message.is_user || !(message.mes || '').trim()) {
            console.log(`[${EXT}] Standalone auto: ignored non-AI/empty message trigger`);
            return;
        }
        await runStandaloneGeneration('', true);
        return;
    }

    if (es.generationMode === 'separate') {
        if (!es.separateEnabled) return;
        await handleSeparateMode();
        return;
    }

    const context = getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user || !es.promptInjection?.regex) return;

    // Auto-fix malformed pic prompts before extraction
    if (es.autoFixPicFormat) {
        const fixed = normalizePicPrompts(message.mes);
        if (fixed !== message.mes) {
            console.log(`[${EXT}] Auto-fixed malformed pic prompt format(s) in message`);
            message.mes = fixed;
            updateMessageBlock(context.chat.length - 1, message);
        }
    }

    const matches = getImagePromptMatches(message.mes, es.promptInjection.regex);
    if (!matches.length) return;

    const mesIdx = context.chat.length - 1;

    setTimeout(async () => {
        try {
            toastr.info(`Generating ${matches.length} image(s)...`);
            if (!message.extra) message.extra = {};
            if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
            if (message.extra.image && !message.extra.image_swipes.includes(message.extra.image)) message.extra.image_swipes.push(message.extra.image);

            for (const match of matches) {
                let imgPrompt = match.prompt;
                if (!imgPrompt.trim()) continue;

                // Run the full processing pipeline
                const processed = processPrompt(imgPrompt, '');
                imgPrompt = processed.prompt;
                markProcessedSdPrompt(imgPrompt);

                const result = await SlashCommandParser.commands['sd'].callback(
                    { quiet: es.insertType === INSERT_TYPE.NEW_MESSAGE ? 'false' : 'true' }, imgPrompt);

                if (es.insertType === INSERT_TYPE.INLINE && typeof result === 'string' && result.trim()) {
                    message.extra.image_swipes.push(result); message.extra.image = result;
                    message.extra.title = imgPrompt; message.extra.inline_image = true;
                    const messageElement = $(`.mes[mesid="${mesIdx}"]`);
                    appendMediaToMessage(message, messageElement); await context.saveChat();
                } else if (es.insertType === INSERT_TYPE.REPLACE && typeof result === 'string' && result.trim()) {
                    const tag = match.full; if (!tag) continue;
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
// STANDALONE GALLERY — isolated from roleplay messages
// ==========================================================================
let _standaloneCancelled = false;
let _standaloneBusy = false;
let _standaloneGenerator = null;

function standaloneChatKey() {
    try {
        const c = getContext();
        return String(c.chatId || c.chat_id || c.groupId || getCurrentCharId() || 'no_chat');
    } catch { return 'no_chat'; }
}
function standaloneLibrary() {
    const st = s().standalone;
    const key = standaloneChatKey();
    if (!st.libraries[key]) st.libraries[key] = { images: [], assistant: [] };
    return st.libraries[key];
}
function syncStandaloneBubbleVisibility() {
    const bubble = $('#ikarus_standalone_bubble');
    if (bubble.length) bubble.toggle(!s().standalone.hideBubble);
}
function createStandaloneWindow() {
    if ($('#ikarus_standalone_bubble').length) return;
    $('body').append(`<button id="ikarus_standalone_bubble" title="Open Standalone Image Studio"><span>🖼️</span></button>
    <section id="ikarus_standalone_window" class="closed">
      <header id="ikarus_standalone_header"><b>Standalone Image Studio</b><span id="ikarus_standalone_status">Ready</span><button id="ikarus_standalone_minimize" type="button" title="Close to bubble">&times;</button></header>
      <nav class="ikarus-standalone-tabs"><button class="active" data-tab="chat">Assistant</button><button data-tab="gallery">Gallery <span id="ikarus_gallery_badge">0</span></button></nav>
      <div class="ikarus-standalone-toolbar"><label class="ikarus-auto-label"><input type="checkbox" id="ikarus_window_auto"><span>Auto mode</span></label><label>Profile <select id="ikarus_window_profile"><option value="">Same as Current</option></select></label><label>Context <input type="number" id="ikarus_window_context" min="1" max="999"></label><label>Images <input type="number" id="ikarus_window_count" min="1" max="30"></label><details class="ikarus-context-sources"><summary>Context sources</summary><div><label><input type="checkbox" id="ikarus_window_include_card"> Character card</label><label><input type="checkbox" id="ikarus_window_include_first"> First message</label><label><input type="checkbox" id="ikarus_window_include_extensions"> Extension injections</label></div></details><button id="ikarus_standalone_clear">Clear gallery</button></div>
      <main id="ikarus_standalone_chat_tab" class="ikarus-standalone-tab active"><div class="ikarus-assistant-intro"><h3>Image Assistant</h3><p>Ask for one image or a chronological scene sequence. Story context is added automatically.</p></div><div id="ikarus_standalone_chatlog"></div></main>
      <main id="ikarus_standalone_gallery_tab" class="ikarus-standalone-tab"><div id="ikarus_standalone_gallery"></div></main>
      <div id="ikarus_standalone_progress"></div>
      <footer><textarea id="ikarus_standalone_request" rows="2" placeholder="Describe an image, or ask for a chronological image sequence..."></textarea><button id="ikarus_standalone_send">Generate</button><button id="ikarus_standalone_stop" disabled>Stop</button></footer>
      <div class="ikarus-resize-grip" title="Drag to resize"></div>
    </section>
    <div id="ikarus_image_viewer" class="closed"><header id="ikarus_viewer_header"><b>Detached Image Viewer</b><span>Drag header · drag corner</span><button class="ikarus-viewer-meta-toggle">Hide details</button><button class="ikarus-viewer-close">&times;</button></header><div class="ikarus-viewer-stage"><button class="ikarus-viewer-prev">&#8249;</button><img alt="Generated image"><button class="ikarus-viewer-next">&#8250;</button></div><aside><div class="ikarus-viewer-actions"><button class="ikarus-viewer-copy">Copy prompt</button><button class="ikarus-viewer-open">Open original</button></div><label>Prompt used</label><textarea readonly></textarea><div class="ikarus-viewer-meta"></div></aside><div class="ikarus-viewer-resize" title="Drag to resize"></div></div>`);
    const win=$('#ikarus_standalone_window'), bubble=$('#ikarus_standalone_bubble');
    syncStandaloneBubbleVisibility();
    function switchTab(tab){ $('.ikarus-standalone-tabs button').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active'); $('.ikarus-standalone-tab').removeClass('active'); $(`#ikarus_standalone_${tab}_tab`).addClass('active'); }
    $('.ikarus-standalone-tabs button').on('click',function(){switchTab($(this).data('tab'));});
    let windowDrag=null, bubbleDrag=null, bubbleMoved=false;
    $('#ikarus_standalone_header').on('pointerdown',function(e){if($(e.target).is('button'))return;const r=win[0].getBoundingClientRect();windowDrag={x:e.clientX-r.left,y:e.clientY-r.top};this.setPointerCapture(e.pointerId);e.preventDefault();});
    $('#ikarus_standalone_header').on('pointermove',function(e){if(!windowDrag)return;const maxX=Math.max(0,innerWidth-win.outerWidth()),maxY=Math.max(0,innerHeight-win.outerHeight());win.css({left:Math.min(maxX,Math.max(0,e.clientX-windowDrag.x)),top:Math.min(maxY,Math.max(0,e.clientY-windowDrag.y)),right:'auto',bottom:'auto'});});
    $('#ikarus_standalone_header').on('pointerup pointercancel',()=>windowDrag=null);
    bubble.on('pointerdown',function(e){const r=this.getBoundingClientRect();bubbleDrag={x:e.clientX-r.left,y:e.clientY-r.top};bubbleMoved=false;this.setPointerCapture(e.pointerId);e.preventDefault();});
    bubble.on('pointermove',function(e){if(!bubbleDrag)return;if(Math.abs(e.movementX)+Math.abs(e.movementY)>1)bubbleMoved=true;const maxX=innerWidth-bubble.outerWidth(),maxY=innerHeight-bubble.outerHeight();bubble.css({left:Math.min(maxX,Math.max(0,e.clientX-bubbleDrag.x)),top:Math.min(maxY,Math.max(0,e.clientY-bubbleDrag.y)),right:'auto',bottom:'auto'});});
    bubble.on('pointerup pointercancel',function(){if(!bubbleMoved){win.removeClass('closed');s().standalone.bubbleOpen=true;saveSettingsDebounced();renderStandaloneGallery();}bubbleDrag=null;});
    $('#ikarus_standalone_minimize').on('click',()=>{win.addClass('closed');s().standalone.bubbleOpen=false;saveSettingsDebounced();});
    $('#ikarus_standalone_send').on('click',()=>{const box=$('#ikarus_standalone_request');const request=box.val()?.trim()||'';if(!request)return;box.val('');appendStandaloneChat('user',request);runStandaloneGeneration(request,false);});
    $('#ikarus_standalone_stop').on('click',stopStandaloneGeneration);
    $('#ikarus_window_auto').on('change',function(){s().standalone.auto=$(this).prop('checked');$('#ikarus_standalone_auto').prop('checked',s().standalone.auto);saveSettingsDebounced();});
    $('#ikarus_window_profile').on('change',function(){s().standalone.profile=$(this).val();$('#ikarus_standalone_profile').val(s().standalone.profile);saveSettingsDebounced();renderStandaloneGallery();});
    $('#ikarus_window_context').on('change',function(){s().standalone.contextSize=Math.max(1,parseInt($(this).val())||1);saveSettingsDebounced();});
    $('#ikarus_window_count').on('change',function(){s().standalone.imageCount=Math.max(1,parseInt($(this).val())||1);saveSettingsDebounced();});
    $('#ikarus_window_include_card').on('change',function(){s().standalone.includeCharacterCard=$(this).prop('checked');$('#ikarus_standalone_include_card').prop('checked',s().standalone.includeCharacterCard);saveSettingsDebounced();});
    $('#ikarus_window_include_first').on('change',function(){s().standalone.includeFirstMessage=$(this).prop('checked');$('#ikarus_standalone_include_first').prop('checked',s().standalone.includeFirstMessage);saveSettingsDebounced();});
    $('#ikarus_window_include_extensions').on('change',function(){s().standalone.includeExtensionPrompts=$(this).prop('checked');$('#ikarus_standalone_include_extensions').prop('checked',s().standalone.includeExtensionPrompts);saveSettingsDebounced();});
    $('#ikarus_standalone_clear').on('click',()=>{if(confirm('Clear this chat gallery?')){standaloneLibrary().images=[];saveSettingsDebounced();renderStandaloneGallery();}});
    let resizeState=null;
    $('.ikarus-resize-grip').on('pointerdown',function(e){const r=win[0].getBoundingClientRect();resizeState={x:e.clientX,y:e.clientY,w:r.width,h:r.height};this.setPointerCapture(e.pointerId);e.preventDefault();e.stopPropagation();});
    $('.ikarus-resize-grip').on('pointermove',function(e){if(!resizeState)return;win.css({width:Math.max(420,resizeState.w+e.clientX-resizeState.x),height:Math.max(380,resizeState.h+e.clientY-resizeState.y)});});
    $('.ikarus-resize-grip').on('pointerup pointercancel',()=>resizeState=null);
    $('#ikarus_image_viewer .ikarus-viewer-close').on('click', closeStandaloneViewer);
    $('#ikarus_image_viewer .ikarus-viewer-meta-toggle').on('click', function () {
        const viewer = $('#ikarus_image_viewer');
        viewer.toggleClass('details-hidden');
        $(this).text(viewer.hasClass('details-hidden') ? 'Details' : 'Hide details');
    });
    let viewerDrag = null;
    let viewerResize = null;
    $('#ikarus_image_viewer').on('pointerdown', '#ikarus_viewer_header', function (e) {
        if ($(e.target).is('button')) return;
        const r = $('#ikarus_image_viewer')[0].getBoundingClientRect();
        viewerDrag = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    $('#ikarus_image_viewer').on('pointermove', '#ikarus_viewer_header', function (e) {
        if (!viewerDrag) return;
        $('#ikarus_image_viewer').css({ left: Math.max(0, e.clientX - viewerDrag.x), top: Math.max(0, e.clientY - viewerDrag.y), right: 'auto', bottom: 'auto' });
    });
    $('#ikarus_image_viewer').on('pointerup pointercancel', '#ikarus_viewer_header', () => viewerDrag = null);
    $('#ikarus_image_viewer').on('pointerdown', '.ikarus-viewer-resize', function (e) {
        const r = $('#ikarus_image_viewer')[0].getBoundingClientRect();
        viewerResize = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
        this.setPointerCapture(e.pointerId);
        e.preventDefault(); e.stopPropagation();
    });
    $('#ikarus_image_viewer').on('pointermove', '.ikarus-viewer-resize', function (e) {
        if (!viewerResize) return;
        $('#ikarus_image_viewer').css({ width: Math.max(500, viewerResize.w + e.clientX - viewerResize.x), height: Math.max(400, viewerResize.h + e.clientY - viewerResize.y) });
    });
    $('#ikarus_image_viewer').on('pointerup pointercancel', '.ikarus-viewer-resize', () => viewerResize = null);
    $('#ikarus_image_viewer .ikarus-viewer-prev').on('click', () => stepStandaloneViewer(-1));
    $('#ikarus_image_viewer .ikarus-viewer-next').on('click', () => stepStandaloneViewer(1));
    $('#ikarus_image_viewer').on('click','.ikarus-viewer-copy',async()=>{const text=$('#ikarus_image_viewer textarea').val();try{await navigator.clipboard.writeText(text);toastr.success('Prompt copied');}catch{toastr.warning('Could not copy prompt');}});
    $('#ikarus_image_viewer').on('click','.ikarus-viewer-open',()=>{const src=$('#ikarus_image_viewer img').attr('src');if(src)window.open(src,'_blank','noopener');});
    $(document).on('keydown.ikarusViewer',e=>{if($('#ikarus_image_viewer').hasClass('closed'))return;if(e.key==='Escape')closeStandaloneViewer();if(e.key==='ArrowLeft')stepStandaloneViewer(-1);if(e.key==='ArrowRight')stepStandaloneViewer(1);});
    if(s().standalone.bubbleOpen)win.removeClass('closed');
    renderStandaloneGallery();
}
function appendStandaloneChat(role,text){
    const lib=standaloneLibrary(); if(!Array.isArray(lib.assistant))lib.assistant=[];
    lib.assistant.push({role,text:String(text||''),createdAt:new Date().toISOString()});
    if(lib.assistant.length>60)lib.assistant=lib.assistant.slice(-60);saveSettingsDebounced();renderStandaloneChat();
}
function renderStandaloneChat(){
    if(!$('#ikarus_standalone_chatlog').length)return;const rows=standaloneLibrary().assistant||[];
    $('#ikarus_standalone_chatlog').html(rows.map(x=>`<div class="ikarus-assistant-message ${x.role}"><b>${x.role==='user'?'You':'Image Assistant'}</b><div>${esc(x.text)}</div></div>`).join(''));
    const el=$('#ikarus_standalone_chatlog')[0];if(el)el.scrollTop=el.scrollHeight;
}
let _standaloneViewerIndex=0;
function renderStandaloneGallery() {
    if (!$('#ikarus_standalone_window').length) return;
    const st=s().standalone, lib=standaloneLibrary();
    $('#ikarus_gallery_badge').text(lib.images.length); renderStandaloneChat();
    $('#ikarus_window_auto').prop('checked',!!st.auto); $('#ikarus_window_context').val(st.contextSize); $('#ikarus_window_count').val(st.imageCount); $('#ikarus_window_include_card').prop('checked',!!st.includeCharacterCard); $('#ikarus_window_include_first').prop('checked',!!st.includeFirstMessage); $('#ikarus_window_include_extensions').prop('checked',!!st.includeExtensionPrompts); const wp=$('#ikarus_window_profile'); if(wp.length){wp.html($('#ikarus_separate_profile').html()||'<option value="">Same as Current</option>');wp.val(st.profile||'');} $('#ikarus_standalone_hide_bubble').prop('checked', !!st.hideBubble); syncStandaloneBubbleVisibility();
    $('#ikarus_standalone_gallery').html(lib.images.length ? lib.images.map((x,i)=>`<figure data-i="${i}"><button class="ikarus-gallery-image" data-i="${i}" title="Open image viewer"><img src="${esc(x.url)}" loading="lazy"></button><figcaption><span>Image ${i+1}</span><span class="ikarus-gallery-actions"><button class="ikarus-gallery-detach" data-i="${i}" title="Open detached viewer">&#8599;</button><button class="ikarus-gallery-info" data-i="${i}" title="View prompt and metadata">&#9998;</button><button class="ikarus-gallery-delete" data-i="${i}" title="Delete image">&times;</button></span></figcaption></figure>`).join('') : '<div class="ikarus-gallery-empty">This chat has no standalone images yet.</div>');
    $('#ikarus_standalone_gallery .ikarus-gallery-image').on('click',function(){openStandaloneViewer(Number($(this).data('i')));});
    $('#ikarus_standalone_gallery .ikarus-gallery-detach').on('click',function(){openStandaloneViewer(Number($(this).data('i')));});
    $('#ikarus_standalone_gallery .ikarus-gallery-info').on('click',function(){openStandaloneViewer(Number($(this).data('i')),true);});
    $('#ikarus_standalone_gallery .ikarus-gallery-delete').on('click',function(){const i=Number($(this).data('i'));if(confirm(`Delete Image ${i+1}?`)){lib.images.splice(i,1);saveSettingsDebounced();renderStandaloneGallery();}});
}
function openStandaloneViewer(index,focusMetadata=false){
    const images=standaloneLibrary().images||[];if(!images.length)return;_standaloneViewerIndex=Math.max(0,Math.min(index,images.length-1));
    const item=images[_standaloneViewerIndex],viewer=$('#ikarus_image_viewer');viewer.find('img').attr('src',item.url);viewer.find('textarea').val(item.prompt||'Prompt not stored for this older gallery item.');viewer.find('.ikarus-viewer-meta').html(`<b>Image ${_standaloneViewerIndex+1} of ${images.length}</b><span>Created: ${esc(item.createdAt?new Date(item.createdAt).toLocaleString():'Unknown')}</span><span>Chat library: ${esc(standaloneChatKey())}</span>`);viewer.removeClass('closed');viewer.find('.ikarus-viewer-prev').prop('disabled',images.length<2);viewer.find('.ikarus-viewer-next').prop('disabled',images.length<2);if(focusMetadata)setTimeout(()=>viewer.find('textarea').trigger('focus').trigger('select'),0);
}
function closeStandaloneViewer(){$('#ikarus_image_viewer').addClass('closed').find('img').attr('src','');}
function stepStandaloneViewer(delta){const images=standaloneLibrary().images||[];if(!images.length)return;_standaloneViewerIndex=(_standaloneViewerIndex+delta+images.length)%images.length;openStandaloneViewer(_standaloneViewerIndex);}
function standaloneContextText() {
    const ctx = getContext();
    const st = s().standalone;
    const n = Math.max(1, Number(st.contextSize) || 1);
    const sections = [];

    if (st.includeCharacterCard) {
        const ch = ctx.characters?.[ctx.characterId] || {};
        const cardParts = [];
        const add = (label, value) => { if (String(value || '').trim()) cardParts.push(`${label}:\n${value}`); };
        add('Name', ch.name || ctx.name2);
        add('Description / appearance', ch.description || ch.data?.description);
        add('Personality', ch.personality || ch.data?.personality);
        add('Scenario', ch.scenario || ch.data?.scenario);
        add("Character's note", ch.system_prompt || ch.data?.system_prompt);
        if (cardParts.length) sections.push(`CHARACTER CARD:\n${cardParts.join('\n\n')}`);
    }

    if (st.includeFirstMessage) {
        const ch = ctx.characters?.[ctx.characterId] || {};
        const first = ch.first_mes || ch.data?.first_mes || ctx.chat?.find(m => !m.is_user)?.mes || '';
        if (String(first).trim()) sections.push(`FIRST MESSAGE:\n${first}`);
    }

    if (st.includeExtensionPrompts) {
        const injected = Object.entries(extension_prompts || {})
            .filter(([key, item]) => key !== PROMPT_KEY && String(item?.value || '').trim())
            .map(([key, item]) => `[${key}]\n${item.value}`);
        if (injected.length) sections.push(`ACTIVE EXTENSION INJECTIONS:\n${injected.join('\n\n')}`);
    }

    const recentMessages=(ctx.chat||[]).filter(m=>m?.mes).slice(-n);
    const recent=recentMessages.map((m,i)=>`${i===recentMessages.length-1?'LATEST MESSAGE - PRIMARY IMAGE SOURCE':'CONTEXT ONLY'} | Message ${i+1} (${m.is_user?'user':'character'}):\n${m.mes}`).join('\n\n');
    sections.push(`RECENT CHAT (last ${n} messages):\n\nIMPORTANT: THE LATEST MESSAGE IS THE ONLY PRIMARY SOURCE FOR NEW IMAGES. EVERYTHING BEFORE IT IS CONTEXT ONLY, used solely for narrative, appearance, location, and continuity consistency. Do not create images for events found only in earlier messages.\n\n${recent}`);
    return sections.join('\n\n=====\n\n');
}
async function requestStandalonePrompts(request, auto) {
    const es=s(), st=es.standalone, count=Math.max(1,Number(st.imageCount)||1), context=standaloneContextText();
    const base=getPromptInjectionText().promptText;
    const system=`${base}\n\n${st.systemPrompt||''}\nYou are a standalone image director. Never roleplay and never rewrite the source messages. Return only ${count} chronological image prompts, each exactly in [pic prompt="..."] format. Each image must depict a distinct visual beat from the LATEST MESSAGE only. Earlier messages are context only and must never become image subjects. Progress through visual beats in the latest message source order.`;
    const user=`${auto?'Automatically create a chronological image sequence from the new story activity.':request||`Create ${count} images from this story context.`}\n\nSTORY CONTEXT:\n${context}`;
    const messages=[{role:'system',content:system},{role:'user',content:user}], ctx=getContext(), profile=st.profile||es.separateProfile||'';
    if (ctx.ConnectionManagerRequestService?.sendRequest) {
        const cg=await sendRequestWithNativeFallback(ctx,profile,messages,{stream:true},`${system}

${user}`,'Standalone'); let out='';
        if(typeof cg==='function'){ _standaloneGenerator=cg(); for await(const chunk of _standaloneGenerator){ if(_standaloneCancelled) break; if(chunk?.text!==undefined){out=chunk.text; $('#ikarus_standalone_progress').text('Planning prompts...');} } }
        else out=cg?.content||cg?.text||String(cg||'');
        return out;
    }
    return await generateRaw(`${system}\n\n${user}`,'',false,false);
}
async function runStandaloneGeneration(request='',auto=false){
    if(_standaloneBusy) return; createStandaloneWindow(); _standaloneBusy=true; _standaloneCancelled=false;
    $('#ikarus_standalone_send').prop('disabled',true); $('#ikarus_standalone_stop').prop('disabled',false); $('#ikarus_standalone_status').text('Planning'); $('#ikarus_standalone_progress').text('Reading story context...');
    try{
        const raw=await requestStandalonePrompts(request,auto); if(_standaloneCancelled) return;
        let matches=getImagePromptMatches(normalizePicPrompts(raw||''),s().promptInjection.regex);
        if(!matches.length) throw new Error('The assistant returned no [pic prompt] entries.');
        appendStandaloneChat('assistant', `Prepared ${matches.length} image prompt${matches.length===1?'':'s'}. Generation has started.`);
        $('#ikarus_standalone_progress').text(`Found ${matches.length} prompts. Generating 0 / ${matches.length}`);
        const lib=standaloneLibrary();
        for(let i=0;i<matches.length;i++){
            if(_standaloneCancelled) break;
            const prompt=processPrompt(matches[i].prompt,'').prompt; markProcessedSdPrompt(prompt);
            $('#ikarus_standalone_status').text(`Generating ${i+1}/${matches.length}`);
            const url=await SlashCommandParser.commands['sd'].callback({quiet:'true'},prompt);
            if(typeof url==='string'&&url.trim()){lib.images.push({id:uid(),url:url.trim(),prompt,createdAt:new Date().toISOString()});saveSettingsDebounced();renderStandaloneGallery();if(i===0)$('.ikarus-standalone-tabs button[data-tab="gallery"]').trigger('click');}
            $('#ikarus_standalone_progress').text(`Generated ${i+1} / ${matches.length}`);
        }
        if(!auto) $('#ikarus_standalone_request').val('');
    }catch(e){appendStandaloneChat('assistant',`Error: ${e.message||e}`);toastr.error(`Standalone: ${e.message||e}`); $('#ikarus_standalone_progress').text(`Error: ${e.message||e}`);}
    finally{_standaloneBusy=false;_standaloneGenerator=null;$('#ikarus_standalone_send').prop('disabled',false);$('#ikarus_standalone_stop').prop('disabled',true);$('#ikarus_standalone_status').text(_standaloneCancelled?'Stopped':'Ready');}
}
function stopStandaloneGeneration(){_standaloneCancelled=true;try{_standaloneGenerator?.return?.();}catch{} $('#ikarus_standalone_status').text('Stopping');}

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
    $('#ikarus_insert_type').on('change', function () { s().insertType = $(this).val(); updateUI(); syncPromptInjection(); saveSettingsDebounced(); });
    $('#ikarus_prompt_injection_enabled').on('change', function () { s().promptInjection.enabled = $(this).prop('checked'); syncPromptInjection(); saveSettingsDebounced(); });
    $('#ikarus_generation_mode').on('change', function () {
        s().generationMode = $(this).val();
        $('.ikarus-separate-options').toggle($(this).val() === 'separate');
        $('.ikarus-standalone-options').toggle($(this).val() === 'standalone');
        if ($(this).val() === 'standalone') createStandaloneWindow();
        syncPromptInjection();
        saveSettingsDebounced();
    });
    $('#ikarus_separate_profile').on('change', function () {
        s().separateProfile = $(this).val();
        saveSettingsDebounced();
    });
    $('#ikarus_separate_enabled').on('change', function () {
        s().separateEnabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#ikarus_separate_context_size').on('input', function () {
        s().separateContextSize = parseInt($(this).val()) || 0;
        saveSettingsDebounced();
    });
    $('#ikarus_standalone_auto').on('change', function(){s().standalone.auto=$(this).prop('checked');saveSettingsDebounced();renderStandaloneGallery();});
    $('#ikarus_standalone_context').on('change',function(){s().standalone.contextSize=Math.max(1,parseInt($(this).val())||1);saveSettingsDebounced();renderStandaloneGallery();});
    $('#ikarus_standalone_count').on('change',function(){s().standalone.imageCount=Math.max(1,parseInt($(this).val())||1);saveSettingsDebounced();renderStandaloneGallery();});
    $('#ikarus_standalone_profile').on('change',function(){s().standalone.profile=$(this).val();saveSettingsDebounced();renderStandaloneGallery();});
    $('#ikarus_standalone_hide_bubble').on('change',function(){s().standalone.hideBubble=$(this).prop('checked');saveSettingsDebounced();syncStandaloneBubbleVisibility();});
    $('#ikarus_standalone_include_card').on('change',function(){s().standalone.includeCharacterCard=$(this).prop('checked');$('#ikarus_window_include_card').prop('checked',s().standalone.includeCharacterCard);saveSettingsDebounced();});
    $('#ikarus_standalone_include_first').on('change',function(){s().standalone.includeFirstMessage=$(this).prop('checked');$('#ikarus_window_include_first').prop('checked',s().standalone.includeFirstMessage);saveSettingsDebounced();});
    $('#ikarus_standalone_include_extensions').on('change',function(){s().standalone.includeExtensionPrompts=$(this).prop('checked');$('#ikarus_window_include_extensions').prop('checked',s().standalone.includeExtensionPrompts);saveSettingsDebounced();});
    $('#ikarus_standalone_system').on('input',function(){s().standalone.systemPrompt=$(this).val();saveSettingsDebounced();});
    $('#ikarus_standalone_open').on('click',function(){createStandaloneWindow();$('#ikarus_standalone_window').removeClass('closed');});
    $('#ikarus_manual_rescan').on('click', handleManualRescan);

    // Section 2: Presets
    $('#ikarus_prompt_text').on('input', function () { s().promptInjection.prompt = $(this).val(); syncPromptInjection(); saveSettingsDebounced(); });
    $('#ikarus_prompt_regex').on('input', function () { s().promptInjection.regex = $(this).val(); saveSettingsDebounced(); });
    $('#ikarus_prompt_position').on('change', function () {
        s().promptInjection.position = $(this).val();
        const isAppend = $(this).val() === 'append_user';
        const isMacro = $(this).val() === 'macro';
        // Hide depth controls when append_user or macro is selected (depth is irrelevant)
        $(this).closest('.ikarus-row').find('div:last-child').toggle(!isAppend && !isMacro);
        $('#ikarus_append_user_hint').toggle(isAppend);
        $('#ikarus_macro_hint').toggle(isMacro);
        syncPromptInjection();
        saveSettingsDebounced();
    });
    $('#ikarus_prompt_depth').on('input', function () { s().promptInjection.depth = parseInt($(this).val()) || 0; syncPromptInjection(); saveSettingsDebounced(); });
    $('#ikarus_preset_select').on('change', function () { loadPreset($(this).val()); });
    $('#ikarus_preset_save').on('click', savePreset);
    $('#ikarus_preset_delete').on('click', deletePreset);

    // Character Prompt (per-card, 5 slots)
    $('#ikarus_char_prompt').on('input', function () { saveCharPrompt(); syncPromptInjection(); });
    $(document).on('click', '.ikarus-slot-btn', function () {
        switchCharSlot(parseInt($(this).data('slot')) || 0);
    });

    // Character Prefix (per-card)
    $('#ikarus_char_prefix').on('input', function () { saveCharPrefix(); });

    // Section 3: Replacements
    // Render the mandatory first trigger row before any replacement can be saved.
    renderReplacementTriggerGroups();
    $('#ikarus_rep_add_group').on('click', function () {
        const groups = readReplacementTriggerGroups();
        groups.push({ trigger: '', matchMode: 'OR' });
        renderReplacementTriggerGroups(groups);
        $('#ikarus_rep_trigger_groups .ikarus-trigger-group:last input').trigger('focus');
    });
    $('#ikarus_rep_trigger_groups').on('click', '.ikarus-trigger-group-remove', function () {
        $(this).closest('.ikarus-trigger-group').remove();
    });
    $('#ikarus_rep_scope_global').on('click', function () { currentRepScope = 'global'; $(this).addClass('active'); $('#ikarus_rep_scope_char').removeClass('active'); renderReplacementList(); });
    $('#ikarus_rep_scope_char').on('click', function () { currentRepScope = 'char'; $(this).addClass('active'); $('#ikarus_rep_scope_global').removeClass('active'); $(this).text(`👤 ${getCurrentCharName()}`); renderReplacementList(); });
    $('#ikarus_rep_add').on('click', function () {
        const pid = _addChildParentId || $(this).data('parent-id') || null;
        addReplacement(pid);
        _addChildParentId = null;
        $('#ikarus_rep_add').text('âž• Add Replacement');
    });
    // Show/hide dedupe tag row based on mode selection
    $('#ikarus_rep_mode').on('change', function () {
        $('#ikarus_rep_short_tag_row').toggle($(this).val() === 'first_full');
    });

    // Section 4: Filters
    $('#ikarus_flt_scope_global').on('click', function () { currentFltScope = 'global'; $(this).addClass('active'); $('#ikarus_flt_scope_char').removeClass('active'); renderFilterList(); });
    $('#ikarus_flt_scope_char').on('click', function () { currentFltScope = 'char'; $(this).addClass('active'); $('#ikarus_flt_scope_global').removeClass('active'); $(this).text(`👤 ${getCurrentCharName()}`); renderFilterList(); });
    renderFilterTriggerGroups();
    $('#ikarus_flt_add').on('click', addFilter);
    $('#ikarus_flt_add_group').on('click',function(){const g=readFilterTriggerGroups();g.push({trigger:'',matchMode:'OR'});renderFilterTriggerGroups(g);$('#ikarus_flt_trigger_groups .ikarus-trigger-group:last input').trigger('focus');});
    $('#ikarus_flt_trigger_groups').on('click','.ikarus-trigger-group-remove',function(){$(this).closest('.ikarus-trigger-group').remove();});
    $('#ikarus_flt_action').on('change', updateFilterFormVisibility);

    // Section 5: Processing & Cleaners
    $('#ikarus_replacements_enabled').on('change', function () {
        s().replacementsEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        toastr.info(`Replacements ${s().replacementsEnabled ? 'enabled' : 'disabled'}`);
    });
    $('#ikarus_invert_order').on('change', function () { s().invertProcessingOrder = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#ikarus_rep_field_mode').val(s().repFieldMode || 'tags');
    $('#ikarus_rep_field_mode').on('change', function () {
        s().repFieldMode = $(this).val(); saveSettingsDebounced();
        renderReplacementList();
        toastr.info(`Replacement mode: ${$(this).val() === 'caption' ? '💬 Caption' : '🏷️ Tags'}`);
    });
    $('#ikarus_auto_clean').on('change', function () { s().autoClean = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#ikarus_auto_fix_pic').on('change', function () { s().autoFixPicFormat = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#ikarus_filter_native_sd').on('change', function () { s().filterNativeSd = $(this).prop('checked'); saveSettingsDebounced(); });
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
        $('#ikarus_rep_add').text(`âž• Add Child of "${parentName}"`);
        $('#ikarus_rep_name').focus();
        toastr.info(`Adding child for "${parentName}". Fill the form and click Add.`);
    });
    $(document).on('click', '.ikarus-transfer-item', function () {
        const c = $(this).closest('.ikarus-card');
        transferItem(c.data('id'), c.data('type'));
    });
    $('#ikarus_rep_manage').on('click', openGlobalManager);
    $('#ikarus_library_manage').on('click', openGlobalManager);

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

        // Register the {{IkarusAutoImage-prompt}} macro for Macro Mode
        try {
            const context = SillyTavern.getContext();
            if (context.macros && typeof context.macros.register === 'function') {
                context.macros.register('IkarusAutoImage-prompt', () => {
                    const es = s();
                    const enabled = es.promptInjection?.enabled && es.insertType !== INSERT_TYPE.DISABLED;
                    const isMacro = es.promptInjection?.position === 'macro';
                    if (!enabled || !isMacro || es.generationMode === 'separate') return '';
                    const { promptText } = getPromptInjectionText();
                    console.log(`[${EXT}] Macro {{IkarusAutoImage-prompt}} resolved (${promptText.length} chars)`);
                    return promptText;
                }, {
                    description: 'Resolves to the fully assembled IkarusAutoImage prompt (including character-specific content). Only active when Macro Mode is selected as position.',
                    category: 'IkarusAutoImage',
                });
                console.log(`[${EXT}] Registered {{IkarusAutoImage-prompt}} macro via context.macros.register()`);
            } else {
                console.warn(`[${EXT}] context.macros.register() not available — macro mode will not work. Update SillyTavern to a newer version.`);
            }
        } catch (error) {
            console.warn(`[${EXT}] Could not register macro:`, error);
        }

        const settingsHtml = await $.get(`${EXT_PATH}/settings.html`);
        $('#extensionsMenu').append(`<div id="ikarus_auto_image_btn" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-feather"></div><span>Ikarus Auto Image</span></div>`);
        $('#ikarus_auto_image_btn').off('click').on('click', onMenuButtonClick);
        await createSettings(settingsHtml);
        if (s().generationMode === 'standalone') createStandaloneWindow();
        syncPromptInjection();
        $('#extensions-settings-button').on('click', () => setTimeout(updateUI, 200));
        console.log(`[${EXT}] Extension loaded`);
    })();
});
