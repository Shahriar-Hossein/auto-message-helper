# Image reading check — 2026-10-07

`gemma4:31b-cloud` can interpret images and read legible text, but the extension's current 384-pixel image limit makes detailed screenshot reading unreliable. A synthetic wide table was read correctly at full resolution and incorrectly after reduction to the extension's capture size.

Live checks used Ollama at `http://127.0.0.1:11434`, with the unmodified `infer` function from `extension/background.js` loaded in a Node VM and the real `extension/core.js`. The extension's normal prompt, automatic vision detection, request options, timeout and reply parsing were retained. No browser settings were changed and no Teams messages were sent. Only generated test images and fictional prompts were sent to the cloud model.

| Input | Result |
| --- | --- |
| Three colored shapes, 384 × 256 | Correct: red square, blue circle, green triangle. |
| Text, 384 × 192 | Exact transcription: `VISION CHECK` and `Code: K7M-492`. |
| Wide table, 1678 × 352 | Correct: cedar = 37 passes / 0.06 profit; maple = 419 / 0.03; total = 2. |
| Same table, 384 × 81 | Incorrect: invented descriptions `lattice` and `rangle`; returned 17 / 0.09 and 419 / 0.01. Only the total and second pass count were correct. |
| Attachment label `image.png 1720x1298`, no pixels | Zero images in request. Model correctly acknowledged it could not see the image. |
| Shape image with vision disabled | Zero images in request. Model correctly acknowledged missing pixels. |

The local model list and `/api/show` advertised vision support for Gemma. None of the other six installed models advertised vision. The actual model selected in browser extension Settings was not confirmed.

`extension/teams.js` captures loaded, browser-readable `img` and `video` elements, scales the longest side to 384 pixels, and encodes JPEG at quality 0.7. Attachment cards without an image element retain their label only. Thus, if the user's filename-only attachment card has no loaded image preview, the extension cannot provide its contents to the model. A screenshot of that card alone cannot establish the actual DOM or outgoing request.

The screenshots attached in chat were not sent to Ollama. The resized synthetic fixture used Pillow Lanczos resizing and JPEG quality 70 to approximate the extension dimensions and compression; browser canvas resampling can differ. Each live case was tested once, so the results establish basic capability and an observed failure, not general accuracy.

Existing validation also passed: `npm test` reported 49 passing tests, including the Chromium test's 79 browser checks; `npm run check` passed. These checks cover image capture and request construction but do not establish model reading accuracy.

Actual replies and request image counts are recorded in [vision-gemma4-31b-cloud.json](model-evaluation/vision-gemma4-31b-cloud.json).
