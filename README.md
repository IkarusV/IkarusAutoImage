# Ikarus Auto Image

A **SillyTavern extension** for automatic AI image generation during roleplay. Detects `[pic prompt="..."]` tags in LLM responses and generates images inline using your configured image generation API.

## Features

- **Auto Image Detection** — Automatically finds `[pic prompt="..."]` tags in AI responses and generates images
- **Prompt Presets** — Save and switch between different prompt injection presets
- **Character Prompts** — Per-character prompt slots (5 per card) that append to image generation prompts
- **Tag Replacements** — Trigger-based find-and-replace for image prompts with parent/child hierarchy support
  <img width="1677" height="704" alt="image" src="https://github.com/user-attachments/assets/17fe2a05-b6cb-4fa4-bc72-f4b153819133" />

- **Prompt Filters** — Conditional actions (remove, append, replace) on generated prompts
- **Global/Character Scope** — Replacements and filters can be global or locked to specific character cards
  <img width="1773" height="808" alt="image" src="https://github.com/user-attachments/assets/13401d18-c944-4cc7-bb7f-b38f7bf45417" />

- **Global Replacement Manager** — Popup window with folder/category organization, search, and full CRUD
<img width="1743" height="1157" alt="image" src="https://github.com/user-attachments/assets/9bb5e7d0-aff8-4890-b41c-65ef6f3bd03c" />


- **Double Cleaner** — Removes duplicate tags after processing
- **Stable Character Data** — Uses avatar filenames as keys (not numeric IDs) so data survives reordering

## Installation

### Via SillyTavern Extension Installer
1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Paste this repo URL: `https://github.com/IkarusV/IkarusAutoImage`
4. Click Install

### Manual Installation
1. Clone or download this repo into your SillyTavern `data/default-user/extensions/` folder:
   ```bash
   cd <SillyTavern>/data/default-user/extensions/
   git clone https://github.com/IkarusV/IkarusAutoImage.git
   ```
2. Restart SillyTavern

## Usage

1. Configure your image generation API in SillyTavern (e.g., Stable Diffusion, NovelAI)
2. Open the Ikarus Auto Image panel in the Extensions sidebar
3. Set up your prompt injection template
4. The extension will automatically detect and render images during chat

### Tag Replacements
Create rules that swap character names for danbooru tags:
- **Trigger:** `Bloom, Dragon fire Fairy, Bloom winx`
- **Replace:** `<lora:AnimaBloom:1>Bloom, fairy wings, red hair`

### Character Prompts
Add per-character style instructions, danbooru tag lists, or generation rules that only apply to specific character cards.

### Global Manager
Click **📂 Manage** to open the folder/category organizer for your global replacements. Create categories (e.g., "Cartoon", "Video Games") and folders (e.g., "Winx Club", "Nier Automata") to keep things tidy.


## License

MIT
