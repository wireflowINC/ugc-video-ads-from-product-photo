# How do I turn a product photo into UGC-style video ads with AI?

Give a video model your product photo as a reference, describe the creator and write the line they say. This repo's Wireflow workflow does that with HeyGen Video: a 5 second vertical clip of an AI creator holding your product and saying your script, voice included, for 30 credits. Run it from Claude over MCP or from a script.

Wireflow is our product: this repo is made by the Wireflow team, so read [Other ways to do this](#other-ways-to-do-this) with that in mind. Every other option links to its own vendor page.

| Product photo in | UGC-style clip out (click to play, sound on) |
|---|---|
| ![A plain cream canvas tote bag with olive straps on a white background, the input photo](examples/input-tote-packshot.jpg) | [![Frame from the test clip: a woman with curly hair in a denim jacket on a couch holds up the cream tote and talks to the camera](examples/tote-ugc-poster.jpg)](https://cdn.wireflow.ai/1d50e1f0-d70e-11f1-b67e-4ba36031b77e.mp4) |

Made by this repo's workflow and script on 3 Nov 2026: HeyGen Video, 5 seconds, 480x832, 30 credits, run `1730ed0c-09c0-49c7-a986-ee94833327be`. The creator is AI-generated and says "Okay, this tote fits my laptop and my gym clothes. Finally, one bag." The plain tote stayed plain: the workflow's rules tell the model to keep the product exactly as in the photo and add no label. The input photo was itself made with AI, so the repo holds nobody's real product.

## How the workflow works

[`workflows/ugc-presenter-heygen.json`](workflows/ugc-presenter-heygen.json) joins fixed presenter rules, your **Presenter** text and your **Script** into one prompt, and sends your **Product Photo** to HeyGen Video as `<Picture 1>`, its reference image. Settings: 5 seconds, 480p, 9:16, prompt enhancement off so the script is spoken as written. Change the length, size or model on the canvas; the scripts below stay the same.

## Set it up

You can run it from an AI agent over MCP (no key) or from code (an API key). The agent steps are copied from the Wireflow docs, read on 3 Nov 2026; video models are on paid Wireflow plans ([pricing](https://www.wireflow.ai/pricing)).

1. **Claude app:** **Customize > Connectors**, **+ Add**, **Add custom connector**, name `Wireflow`, URL `https://www.wireflow.ai/api/mcp`, **Continue** twice, **Add**, then sign in. Tick `workflows:write` on the consent screen so Claude can send you upload links for your own photos ([Claude app setup](https://www.wireflow.ai/docs/agents/claude-app), updated 26 Oct 2026).
2. **Claude Code:** `claude mcp add --transport http wireflow https://www.wireflow.ai/api/mcp`, then `/mcp` to sign in, or open this repo, which has a [`.mcp.json`](.mcp.json) ([Claude Code setup](https://www.wireflow.ai/docs/generate-videos-in-claude-code), updated 29 Oct 2026).
3. **Cursor:** the `wireflow` entry in this repo's [`.cursor/mcp.json`](.cursor/mcp.json) or in `~/.cursor/mcp.json`, toggle it on under **Customize**, sign in ([Cursor setup](https://www.wireflow.ai/docs/generate-images-and-videos-in-cursor), updated 24 Oct 2026).
4. **Codex:** `codex mcp add wireflow --url https://www.wireflow.ai/api/mcp`, then `codex mcp login wireflow`, or this repo's [`.codex/config.toml`](.codex/config.toml) ([Codex setup](https://www.wireflow.ai/docs/generate-images-and-videos-with-codex), updated 24 Oct 2026).

## Run it

### From Claude, Cursor or Codex

Ready-made skills do the planning and quote before they spend:

- [ugc-ad-generator](https://github.com/wireflowINC/skills/tree/main/skills/ugc-ad-generator): product photo, hook and an AI creator to a 6 second vertical talking clip with sound (Seedream 5 Lite still, then Veo 3.1 Lite). Install: `npx skills add wireflowINC/skills --skill ugc-ad-generator`.
- [heygen-video-product-video](https://github.com/wireflowINC/skills/tree/main/skills/heygen-video-product-video): an 8 second presenter clip with HeyGen Video, the same model as this repo.

Or ask in plain words. This prompt is from the Claude app docs, with the shot changed to a UGC clip:

```text
Use Wireflow. Send me an upload link for a photo of my product. When I say it's uploaded, check that it landed, then build a draft board that turns it into a 5-second vertical video of a friendly creator holding the product and saying "This changed my mornings." Tell me the model and its credit cost, and wait for my yes before you run it. When it finishes, give me the video link.
```

### From code

Create an API key in Wireflow under **Settings > API Keys** with `workflows:write` (create the workflow, upload photos), `workflows:execute` and `executions:read` (run and read), or **Full access**. Node 18 or newer, no packages.

```bash
export WIREFLOW_API_KEY="your key"          # PowerShell: $env:WIREFLOW_API_KEY = "your key"

# 1. Save the workflow in your account (free).
node scripts/create-workflow.mjs workflows/ugc-presenter-heygen.json

# 2. One ad. "@" uploads a local photo to the Wireflow CDN first and sends its URL.
node scripts/wireflow-run.mjs --workflow <your workflow id> \
  --input product-photo=@examples/input-tote-packshot.jpg \
  --input presenter="A friendly woman in her late 20s with curly dark hair and a denim jacket, on her couch in a bright apartment." \
  --input script="Okay, this tote fits my laptop and my gym clothes. Finally, one bag."
```

The MP4 lands in `./wireflow-outputs/<date>/<run id>/`. Photos up to 4 MB upload in one call and bigger ones through a signed upload URL, both handled by the script ([upload a file and use it in a run](https://www.wireflow.ai/docs/api/upload-a-file-and-use-it-in-a-run), updated 20 Oct 2026).

### Hook variants in one go

Test several opening lines on the same product and creator: one row per script in a CSV, the photo and the presenter fixed for every row.

```bash
node scripts/batch-from-csv.mjs --workflow <your workflow id> --csv examples/hooks.csv \
  --input product-photo=@examples/input-tote-packshot.jpg \
  --input presenter="A friendly woman in her late 20s with curly dark hair and a denim jacket, on her couch." --dry-run
# drop --dry-run to start the 3 runs; each row has its own retry key, so a rerun replays instead of billing twice
```

### What it costs

The test run was quoted and charged 30 credits (5 seconds, 480p, 9:16). The [model list](https://www.wireflow.ai/api/v1/models) (read 3 Nov 2026) prices HeyGen Video at 5 credits a second with a 23-credit reference run, so check the price at your own settings: on the same day the API quoted 72 credits for 8 seconds at 768p. The ugc-ad-generator skill's Veo 3.1 Lite step is listed at 16 credits a second. Agencies: every run is charged to the Wireflow account whose key or sign-in starts it.

For the whole UGC pipeline on the canvas (scripts, avatars, voice and assembly), see Wireflow's [AI UGC workflow guide](https://www.wireflow.ai/ai-ugc-workflow).

## What's in this repo

| File | What it is |
|---|---|
| [`workflows/ugc-presenter-heygen.json`](workflows/ugc-presenter-heygen.json) | The tested workflow: product photo, presenter and script into HeyGen Video |
| [`scripts/create-workflow.mjs`](scripts/create-workflow.mjs) | Lints the workflow file, saves it in your account, prints its id |
| [`scripts/wireflow-run.mjs`](scripts/wireflow-run.mjs) | Uploads `@local` photos, runs the workflow, waits, downloads the MP4, writes `manifest.json` |
| [`scripts/batch-from-csv.mjs`](scripts/batch-from-csv.mjs) | One run per CSV row (hook variants), `results.csv` |
| [`examples/hooks.csv`](examples/hooks.csv) | Three sample hooks |
| [`examples/input-tote-packshot.jpg`](examples/input-tote-packshot.jpg) | The AI-made sample product photo used in the test |
| [`.mcp.json`](.mcp.json), [`.cursor/mcp.json`](.cursor/mcp.json), [`.codex/config.toml`](.codex/config.toml) | MCP configs for Claude Code, Cursor and Codex |

## Other ways to do this

Facts below are from each vendor's own pages, as recorded in our tool fact files on the dates shown.

- **[Creatify](https://creatify.ai/)**: UGC-style video ads with AI actors and ad templates; Starter is $39 a month (100 credits), Pro at $99 a month adds the Creatify MCP for Claude and ChatGPT, and the free plan watermarks exports (Creatify pricing, checked 11 Oct 2026).
- **[MakeUGC](https://makeugc.ai/)**: UGC-style videos with AI actors, plus Batch Mode, API and MCP access on every plan; Starter is $29 a month billed yearly with 720p exports, and a talking-actor video is 100 credits (MakeUGC site and API docs, checked 11 Oct 2026).
- **[Arcads](https://www.arcads.ai/)**: creates, edits and launches video ads with a library of 1,000+ AI actors and a free trial; no plan price is published on its site (checked 11 Oct 2026).
- **[HeyGen](https://www.heygen.com/)**: HeyGen's own app for avatar and spokesperson videos in many languages; the Free plan makes 3 watermarked videos a month up to 1 minute each, and Creator is $29 a month (HeyGen pricing, checked 31 Oct 2026).
- **[Topview](https://www.topview.ai/)**: a marketing video agent for avatar and product videos; Plus is $36 a month billed annually with 100 credits a month and includes API and MCP access (Topview pricing, checked 11 Oct 2026).

## Tested

| | |
|---|---|
| Date | 3 Nov 2026 (2026-11-02 22:38 UTC) |
| Host | Wireflow REST API, called by `scripts/wireflow-run.mjs` on Node 24, Windows 11: the local photo went up through `POST /api/v1/media/upload`, then the run through `POST /api/v1/workflows/{id}/run` |
| Model | HeyGen Video, one 5 second 480x832 MP4 with sound, about 20 seconds start to file |
| Run id | `1730ed0c-09c0-49c7-a986-ee94833327be` |
| Credits | 30, from the account's credit history |

The hook batch uses the same `batch-from-csv.mjs` that was tested on a real two-row batch in the sibling recipe `wireflowINC/bulk-product-photos`. The MCP setup steps are copied from the Wireflow docs on 3 Nov 2026; the test did not sign in over MCP. We re-check the docs, the model list and this block once a month.

## License

[MIT](LICENSE). The example photo and clip were made with AI on Wireflow.
