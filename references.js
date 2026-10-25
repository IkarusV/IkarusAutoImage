// Field capabilities are independent of saved reference images. Add future fields here.
export const FIELD_CAPABILITIES = {
    tags: { referenceImages: false },
    caption: { referenceImages: false },
    krea2: { referenceImages: true, requiredLora: 'krea2_general_edit_v2', overrides: { krea2_do_reference: true } },
};

export function selectReferences(source, firedRules, mode, limit = 0) {
    if (!FIELD_CAPABILITIES[mode]?.referenceImages) return [];
    const text = String(source).toLowerCase();
    const position = (rule) => {
        const group = rule.triggerGroups?.[0]?.trigger || rule.trigger || '';
        const offsets = group.split(',').map(word => text.indexOf(word.trim().toLowerCase())).filter(i => i >= 0);
        return offsets.length ? Math.min(...offsets) : Infinity;
    };
    const seen = new Set();
    const result = firedRules.map((rule, index) => ({ rule, index, at: position(rule) }))
        .sort((a, b) => a.at - b.at || a.index - b.index)
        .flatMap(({ rule }) => {
            const data = rule.referenceImage?.dataUrl;
            if (typeof data !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/i.test(data) || seen.has(data)) return [];
            seen.add(data);
            return [data];
        });
    return Number(limit) > 0 ? result.slice(0, Math.floor(Number(limit))) : result;
}

export function injectReferencePayload(payload, plan) {
    const capability = FIELD_CAPABILITIES[plan?.mode];
    if (!capability?.referenceImages) return payload;
    const images = plan.references || [];
    const scripts = { ...(payload.alwayson_scripts || {}) };
    const key = Object.keys(scripts).find(name => name.toLowerCase() === 'imagestitch integrated') || 'ImageStitch Integrated';
    // Always set all three args to prevent Forge's cached references carrying into the next request.
    scripts[key] = { ...scripts[key], args: [images.length > 0, images, Math.min(2048, Math.max(0, Number(plan.maxSide) || 0))] };
    const result = { ...payload, alwayson_scripts: scripts };
    if (images.length) {
        if (capability.requiredLora) {
            const name = capability.requiredLora;
            result.prompt = `<lora:${name}:1> ${String(payload.prompt || '').replace(new RegExp(`<lora:${name}:[^>]+>`, 'gi'), '').trim()}`;
        }
        result.override_settings = { ...payload.override_settings, ...capability.overrides };
        if (payload.override_settings_restore_afterwards === undefined) result.override_settings_restore_afterwards = true;
    }
    return result;
}

export function makePendingRequests(now = () => Date.now()) {
    const queue = [];
    const prune = () => { for (let i = queue.length - 1; i >= 0; i--) if (now() - queue[i].at > 60000) queue.splice(i, 1); };
    return {
        add(prompt, plan) { prune(); queue.push({ prompt: String(prompt), plan, at: now() }); if (queue.length > 100) queue.shift(); },
        take(prompt) {
            prune();
            const text = String(prompt || '');
            // SillyTavern can add its configured prompt prefix/suffix after the prompt event.
            const index = queue.findIndex(item => item.prompt && (text === item.prompt || text.includes(item.prompt)));
            if (index < 0) return null;
            return queue.splice(index, 1)[0].plan;
        },
    };
}
