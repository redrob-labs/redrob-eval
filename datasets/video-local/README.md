# video-local/

Human-labeled skill clips / frame-sets for checklist scoring **cannot** be vendored
into this repo under the Apache-compatible datasets rule used elsewhere in `datasets/`.

This directory holds **local manifests only** (gitignored). Each JSON file points at
frame images + human labels stored **outside** the repo.

## Schema (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "id": "solder-demo",
  "label": "Hand soldering process checks",
  "metric": "qwk",
  "anchors": [
    { "label": "beginner", "framePaths": ["/abs/path/to/beg_01.png", "/abs/path/to/beg_02.png"] },
    { "label": "skilled", "framePaths": ["/abs/path/to/sk_01.png"] }
  ],
  "examples": [
    {
      "id": "clip_001",
      "framePaths": ["/abs/path/to/clip001/f00.png", "/abs/path/to/clip001/f01.png"],
      "label": "{\"items\":[1,0,1],\"total\":2}",
      "context": "bench A, daylight"
    }
  ]
}
```

Rules:

- List **pre-extracted frame images**, never raw video paths you intend to persist.
- The harness loads selected frames into memory for one scoring call and discards them.
- No video bytes go into `datasets/`, logs, or `exports/`.

See `docs/methodology.md` § Video-local datasets.
