import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const moduleSource = await readFile(new URL('references.js', root), 'utf8');
const { selectReferences, injectReferencePayload, FIELD_CAPABILITIES, makePendingRequests } = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
const source = await readFile(new URL('index.js', root), 'utf8');
const image = value => ({ dataUrl: 'data:image/png;base64,' + Buffer.from(value).toString('base64'), name: value });
const erza = { id: 'erza', trigger: 'Erza', referenceImage: image('erza'), replacement: 'red hair', krea2: 'red-haired woman', priority: 5, enabled: true, scope: 'global' };
const lucy = { ...erza, id: 'lucy', trigger: 'Lucy', referenceImage: image('lucy'), replacement: 'blonde', krea2: 'blonde woman', priority: 0 };
function actualMatching(rules, text) {
    const settings = { repFieldMode: 'krea2', replacements: rules };
    const context = vm.createContext({ s: () => settings, activeItems: x => x.filter(r => r.enabled), cleanPrompt: x => x, EXT: 'test', console: { log() {} } });
    const snippets = [
        source.slice(source.indexOf('function normalizeReplacementTriggerGroups'), source.indexOf('function renderReplacementTriggerGroups')),
        source.slice(source.indexOf('function applyReplacements('), source.indexOf('// PROCESSING: Apply Filters')),
        'function escRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }',
    ];
    vm.runInContext(snippets.join('\n'), context);
    context.text = text;
    return vm.runInContext('const matches=[];const output=applyReplacements(text,matches);({output, ids: matches.map(r=>r.id)})', context);
}
test('references follow original prompt order rather than rule priority', () => {
    assert.deepEqual(selectReferences('Lucy and Erza', [erza, lucy], 'krea2'), [lucy.referenceImage.dataUrl, erza.referenceImage.dataUrl]);
});
test('default unlimited, explicit limit, and image deduplication', () => {
    assert.equal(selectReferences('Erza Lucy', [erza, lucy, erza], 'krea2', 0).length, 2);
    assert.deepEqual(selectReferences('Lucy Erza', [erza, lucy], 'krea2', 1), [lucy.referenceImage.dataUrl]);
});
test('tags and caption never send references', () => {
    for (const mode of ['tags', 'caption']) {
        assert.deepEqual(selectReferences('Erza', [erza], mode), []);
        const payload = { prompt: 'test' }; assert.equal(injectReferencePayload(payload, { mode, references: [] }), payload);
    }
});
test('future fields opt in independently of Krea adapters and options', () => {
    FIELD_CAPABILITIES.future = { referenceImages: true };
    const result = injectReferencePayload({ prompt: 'hello' }, { mode: 'future', references: [image('a').dataUrl], maxSide: 0 });
    assert.equal(result.prompt, 'hello'); assert.equal(result.override_settings.krea2_do_reference, undefined);
    assert.equal(result.alwayson_scripts['ImageStitch Integrated'].args[2], 0);
    delete FIELD_CAPABILITIES.future;
});
test('request preserves scripts, options and other LoRAs, normalizes edit adapter once', () => {
    const payload = { prompt: 'hello <lora:style:0.7> <lora:krea2_general_edit_v2:0.2>', override_settings: { sd_model_checkpoint: 'krea' }, alwayson_scripts: { Other: { args: [9] }, 'imagestitch integrated': { args: [] } } };
    const result = injectReferencePayload(payload, { mode: 'krea2', references: [erza.referenceImage.dataUrl], maxSide: 512 });
    assert.match(result.prompt, /^<lora:krea2_general_edit_v2:1>/); assert.match(result.prompt, /<lora:style:0.7>/);
    assert.equal((result.prompt.match(/krea2_general_edit_v2/g) || []).length, 1);
    assert.deepEqual(result.alwayson_scripts.Other, payload.alwayson_scripts.Other);
    assert.deepEqual(result.override_settings, { sd_model_checkpoint: 'krea', krea2_do_reference: true });
    assert.equal(result.alwayson_scripts['imagestitch integrated'].args[2], 512);
    assert.equal(payload.alwayson_scripts['imagestitch integrated'].args.length, 0);
});
test('a Krea request without references explicitly disables stale ImageStitch cache', () => {
    const result = injectReferencePayload({ prompt: 'scene' }, { mode: 'krea2', references: [], maxSide: 1024 });
    assert.deepEqual(result.alwayson_scripts['ImageStitch Integrated'].args, [false, [], 1024]);
    assert.equal(result.prompt, 'scene');
});
test('concurrent prompts retrieve their own plans and consume them once', () => {
    const queue = makePendingRequests(); queue.add('Erza scene', { id: 1 }); queue.add('Lucy scene', { id: 2 });
    assert.equal(queue.take('prefix Lucy scene suffix').id, 2); assert.equal(queue.take('Erza scene').id, 1); assert.equal(queue.take('Erza scene'), null);
});
test('expired request plans are discarded', () => {
    let time = 0; const queue = makePendingRequests(() => time); queue.add('scene', {}); time = 60001; assert.equal(queue.take('scene'), null);
});
test('actual matching includes parent and gated child, excludes unmet child', () => {
    const child = { ...lucy, id: 'armor', parentId: 'erza', trigger: 'armor', matchMode: 'CHILD' };
    assert.deepEqual(Array.from(actualMatching([erza, child], 'Erza wearing armor').ids), ['erza', 'armor']);
    assert.deepEqual(Array.from(actualMatching([erza, child], 'armor alone').ids), []);
});
test('actual matching preserves disabled rules, extra conditions, and child priority behavior', () => {
    const child = { ...lucy, id: 'armor', parentId: 'erza', trigger: 'armor', matchMode: 'CHILD', priority: 5 };
    const other = { ...child, id: 'lower', priority: 0 };
    assert.deepEqual(Array.from(actualMatching([erza, child, other, { ...lucy, enabled: false }], 'Erza wearing armor Lucy').ids), ['erza', 'armor']);
    const conditional = { ...erza, triggerGroups: [{ trigger: 'Erza', matchMode: 'OR' }, { trigger: 'forest', matchMode: 'AND' }] };
    assert.deepEqual(Array.from(actualMatching([conditional], 'Erza at home').ids), []);
});

test('actual fetch hook attaches only the matching local request and preserves headers and signal', async () => {
    const calls = [];
    const context = vm.createContext({
        makePendingRequests, injectReferencePayload, URL, Request, Date, Symbol,
        location: { href: 'http://localhost:8000/', origin: 'http://localhost:8000' },
        window: { fetch: async (input, init) => { calls.push({ input, init }); return { ok: true }; } },
    });
    const begin = source.indexOf('const _referencePlans =');
    const end = source.indexOf('function resetReplacementEditor()');
    vm.runInContext(source.slice(begin, end), context);
    vm.runInContext(`_referencePlans.set('transport test', {mode:'krea2', references:['data:image/png;base64,ZXJ6YQ=='],maxSide:0,at:Date.now()});queueReferencePlan('transport test');`, context);
    const controller = new AbortController();
    const options = { method: 'POST', headers: { 'X-CSRF-Token': 'test-token' }, signal: controller.signal, body: JSON.stringify({ prompt: 'prefix, transport test, suffix' }) };
    await context.window.fetch('http://elsewhere/api/sd/generate', options);
    assert.equal(calls[0].init, options);
    await context.window.fetch('/api/sd/generate', options);
    const result = calls[1].init;
    assert.equal(result.headers, options.headers); assert.equal(result.signal, controller.signal);
    assert.equal(JSON.parse(result.body).alwayson_scripts['ImageStitch Integrated'].args[2], 0);
    await context.window.fetch('/api/sd/generate', options);
    assert.equal(calls[2].init, options);
});
