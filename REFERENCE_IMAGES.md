# Character and object reference images

## Use

Reload SillyTavern after installing the update. In Replacements, select the existing Global or character scope, then add or edit a rule. Choose a PNG, JPEG, or WebP under Reference image. A thumbnail and filename appear immediately. Click Add / Update Replacement to save, just as with tags or captions. Removing a reference also requires saving the rule. The Global Manager's add and edit forms have the same controls.

Each parent or child rule stores its own optional image. The same saved image can be used by future prompt field modes; uploads are not tied to a particular model. References are saved in the rule's `referenceImage` property as `{dataUrl, name, width, height}`. They use existing SillyTavern settings persistence and scopes. Original pixels are retained; the reference size control is applied at generation time. The upload guard is 25 MB per image. Saved settings include the image data.

Select the K2 / Krea2 replacement mode to send references. Tags and Caption do not send references. The collection uses the existing rule matching pipeline, including enabled state, scope, additional trigger groups, parent gating, and child priority conflicts. A reference is included only when its rule fires. Existing replacement text and prompt processing continue to work. This applies to Together, Separate, and Standalone generation paths using SillyTavern's native Stable Diffusion generation endpoint.

References are ordered by their trigger's first position in the incoming prompt (including the character prefix). Ties and triggers introduced by replacements retain firing order. Identical image data is sent once. You can describe the character or object as coming from a reference in its Krea2 field.

In Krea2 mode, a request with reference images automatically starts with `<lora:krea2_general_edit_v2:1>`. Duplicate uses of this adapter are normalized to one; other LoRAs remain in the prompt. The LoRA must be installed on the Forge host. The extension sets `krea2_do_reference: true` for that request.

## Limits and resolution

- Reference image limit: 0 means unlimited; a positive number sends the first N selected references.
- Reference maximum side: default 1024, adjustable in 64-pixel steps from 0 through 2048. Zero means no maximum-side reduction in ImageStitch. Forge still rounds reference dimensions to multiples of 64.

These controls affect reference conditioning. Output width and height continue to come from SillyTavern's generation settings. A smaller reference often reduces reference encoding cost and VRAM use. The API sends its own ImageStitch arguments, so changing the ImageStitch slider in Forge's browser does not override this extension's value.

NaviDataset has its own Maximum reference side setting, now also supporting 0 for unlimited. Set each application's value independently.

## API integration

`references.js` builds the existing native Forge Neo payload:

```json
{
  "prompt": "<lora:krea2_general_edit_v2:1> your processed scene",
  "alwayson_scripts": {
    "ImageStitch Integrated": {
      "args": [true, ["data:image/png;base64,...", "data:image/webp;base64,..."], 1024]
    }
  },
  "override_settings": {"krea2_do_reference": true},
  "override_settings_restore_afterwards": true
}
```

The extension adds fields to SillyTavern's `/api/sd/generate` JSON request; SillyTavern already forwards them to Forge's `/sdapi/v1/txt2img`. Other script entries and override options are preserved. Krea2 requests with no collected references explicitly send `[false, [], maxSide]` so ImageStitch does not reuse cached references from the previous generation.

Prompt plans are collected during processing and paired with individual `SD_PROMPT_PROCESSING` events. A same-origin fetch wrapper consumes the matching plan once. Requests from other providers or unmatched prompts are passed through. No direct Forge connection or extra CORS configuration is introduced.

## Future field modes

`FIELD_CAPABILITIES` in `references.js` declares whether each prompt field can use references. To support a new prompt field, implement that field in the existing editor/normalization/replacement selector, then add its capabilities, for example:

```js
FIELD_CAPABILITIES.futureEdit = { referenceImages: true };
```

Optional `requiredLora` and `overrides` entries supply model-specific requirements. Existing rule images remain usable without migration. Krea-specific options are declared only on the Krea2 capability entry.

## Verification

Run `node --test tests/references.test.mjs` from this extension directory. Eleven checks cover actual parent/child matching, conditional rules, disabled rules, priorities, prompt-order selection, deduplication, image limits, field gating, future capabilities, LoRA preservation, cache clearing, concurrent request correlation, and the actual fetch hook with headers and abort signal preservation.

Browser verification exercised the real prompt-processing event with two temporary rules, inspected the request handler payload, and tested upload/preview/removal without saving a rule or issuing a generation. A real Forge generation is the remaining image-level verification.

Pre-change files, including the user's existing source edits, were copied to `C:\Temp\ikarus-reference-backup-20261024-165716`.
