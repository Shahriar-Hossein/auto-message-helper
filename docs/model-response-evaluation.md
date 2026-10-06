# Local and cloud reply comparison — 2026-10-06

Follow-up: [Nemotron 3 Super and GPT-OSS 120B Cloud comparison](cloud-model-followup.md) adds 48 API calls against the same fictional cases. Gemma remains the strongest tested combination for this workload.

For these short, mixed English/Banglish conversations, **Gemma 4 31B Cloud with thinking disabled and the refined prompt was the strongest tested combination**. GPT-OSS 20B Cloud completed more replies once given a sufficient reasoning/output budget, but continued to make speaker, language, and factual mistakes. Neither installed small local model became reliable with the tested prompt or sampling changes.

This report covers **99 actual API responses** from this comparison: 81 conversation tests and 18 language controls. The 44 earlier local tests are separate. Eight fictional conversations covered an AI joke, friendship, a demo request, a money update, a call/library update, two consecutive topics, an unknown deadline, and an English friendship question. All cloud payloads used newly written fictional conversations, with no actual chat names, links, dates, or identifiers. The original screenshot samples were tested only locally in the earlier run.

Automatic approval review rejected exporting the original conversation samples because it judged consent for that specific payload/destination insufficient. The fictional comparison was approved and completed instead.

Each reply was read against the stated case criterion. **Completion is not correctness**, and there is no automated semantic pass score. The refined Gemma replies were clearly useful in six cases; the demo and money acknowledgements were safe but vague. Those are qualitative judgments on a small sample, not a production accuracy guarantee. Prompts and some settings changed together, so these trials do not isolate the effect of every individual change. Timings include network time and interleaved runs; they are observations, not a controlled latency benchmark. Seeds were requested where the API supports them, but no reproducibility guarantee is assumed.

## What improved results

- Explicit `Owner` and `Recipient` labels reduced confusion between the account owner, bot, and recipient in Gemma's replies. `my hooman` identifies only the owner.
- Keeping earlier chat separate from the latest consecutive incoming messages helped Gemma answer both questions in a burst rather than only the last line.
- Examples in both English and Banglish helped the refined Gemma prompt follow the recipient's language. The examples demonstrate friendship, missing information, and acknowledgement without copying the recipient's first-person claims.
- Restricting the friendship reassurance to relevant questions stopped the current prompt's friendship/getting-rich theme from entering unrelated replies.
- Saying the bot only writes text, and cannot claim to have noted, forwarded, checked, paid, or notified anyone, removed unsupported actions from the refined Gemma outputs in this sample set.
- Adding tokens helped GPT-OSS finish, but did not repair its semantic mistakes. Medium reasoning was slower and did not consistently improve Banglish or speaker accuracy.

## Local models

`qwen2.5-coder:1.5b` continued to echo, offer generic help, or confuse the owner and recipient. A minimal English input let it correctly summarize a payment relationship and reassure about friendship, but it still invented a call and did not consistently write an appropriate message. Changing the same fictional inputs into Bangla script did not solve it.

`qwen3:1.7b` also confused speakers and copied inputs. The documented non-thinking sampling settings (`temperature: 0.7`, `top_p: 0.8`, `top_k: 20`, `min_p: 0`) did not make this workload reliable. A local thinking test took **37.43 seconds**, exceeding the extension's **25-second** request timeout, and still falsely said the bot could call and was also at the library. Some minimal-prompt controls produced unexpected reasoning markers in the answer despite requesting `think: false`; these would be rejected by the existing reply parser. The saved control artifacts retain only the final text when such markers occurred.

A practical next local experiment is a larger general chat/instruction model with strong multilingual support, rather than another prompt tweak on the saved 1.5B coder model. No larger local model was downloaded or validated here. Converting input to clear English improved some comprehension in this test, but did not solve the persona/ownership problem and is not implemented as an automatic translation feature.

## Cloud models and output budgets

**Gemma:** the recommended tested recipe is `gemma4:31b-cloud`, `think: false`, `temperature: 0.4`, `num_predict: 256`, and the `refined` prompt. It produced relevant Banglish, kept the owner distinct, and avoided invented callbacks and logged notes in this run. Turning thinking on with a 1,024-token budget produced empty, length-limited final answers in five of eight cases; it is a poor fit for these short replies under that budget.

**GPT-OSS:** the extension's current 128-token request hit `done_reason: length` in six of eight fictional cases. Five had no final answer; one had a cut-off sentence. `think: low` and `num_predict: 1024` completed all eight under the focused prompt. Requesting English improved several replies, but the demo answer still promised attendance and the money answer claimed a future check despite those actions being unconfirmed. Medium reasoning completed replies more slowly and still invented actions. It was weaker than Gemma for this particular Banglish workload.

GPT-OSS has named reasoning levels; the tested Ollama control was `think: "low"`, rather than attempting to disable it as a Boolean. See [official OpenAI GPT-OSS documentation](https://developers.openai.com/api/docs/models/gpt-oss-20b) and [Ollama thinking controls](https://docs.ollama.com/capabilities/thinking). The local sampling experiment follows [Qwen's official quickstart](https://github.com/QwenLM/Qwen3/blob/main/docs/source/getting_started/quickstart.md).

## Actual Gemma responses with the refined prompt

The app adds the fixed Chuckles introduction. These are the actual model-generated bodies:

| Case | Actual reply |
| --- | --- |
| Friendship | Na na, my hooman bondhuder kokhono bhule na! |
| Call and library | My hooman call korechilen kina sheta amar jana nei. Library te bhalo kore porashona koro! |
| Two-topic burst | My hooman bondhuder kokhono bhule na. Network thik hoyeche jene bhalo laglo! |
| Unknown deadline | The finish date is currently unknown. |
| Demo request (vague) | Demo ta dekhaben ki na sheta ekhono unknown. |
| Money update (vague) | Thursday-r kotha mone rakhar jonno dhonnobad! |

## Observed completion and latency

The length-limit column measures API completion, not whether the reply is correct. Each full row has eight cases unless otherwise noted.

| Model | Profile | Calls | Median | Range | Length limits |
| --- | --- | ---: | ---: | --- | ---: |
| `gemma4:31b-cloud` | `baseline` | 8 | 2.87s | 0.82–3.07s | 0 |
| `gemma4:31b-cloud` | `focused` | 8 | 0.78s | 0.62–1.63s | 0 |
| `gemma4:31b-cloud` | `refined-thinking` | 8 | 4.44s | 2.05–7.17s | 5 |
| `gemma4:31b-cloud` | `refined` | 8 | 1.09s | 0.77–9.14s | 0 |
| `gpt-oss:20b-cloud` | `baseline` | 8 | 2.87s | 1.85–3.62s | 6 |
| `gpt-oss:20b-cloud` | `focused-english` | 8 | 4.35s | 1.03–5.22s | 0 |
| `gpt-oss:20b-cloud` | `focused` | 8 | 1.04s | 0.96–1.89s | 0 |
| `gpt-oss:20b-cloud` | `refined-medium` | 8 | 6.04s | 2.35–11.72s | 0 |
| `qwen2.5-coder:1.5b` | `focused` | 8 | 1.66s | 1.24–7.20s | 0 |
| `qwen3:1.7b` | `focused` | 8 | 2.03s | 1.59–8.18s | 0 |
| `qwen3:1.7b` | `thinking` | 1 | 37.43s | 37.43–37.43s | 0 |

## Repeat the comparison

The standalone [runner](../tools/compare-responses.cjs) contains only the fictional fixtures and tested prototype prompts. `baseline` calls the current extension's prompt with its default settings; other profiles are experiments and do not modify browser settings or the extension's runtime. Results are saved as JSON under `docs/model-evaluation/`. The runner uses a 60-second diagnostic timeout so it can identify requests that exceed the extension's 25-second timeout.

```bash
node tools/compare-responses.cjs gemma4:31b-cloud refined
node tools/compare-responses.cjs gpt-oss:20b-cloud focused
node tools/compare-responses.cjs gpt-oss:20b-cloud focused-english
node tools/compare-responses.cjs qwen2.5-coder:1.5b focused
node tools/compare-responses.cjs qwen3:1.7b focused
```

Cloud model aliases such as `gemma4:31b-cloud` and `nemotron-3-super:cloud` send these fictional samples to Ollama Cloud through your local Ollama server and require your Ollama account's cloud access. The runner defines each profile’s settings; the JSON records the model ID, prompt profile, timings, final text, and stop reason. Hidden `message.thinking` text is not collected. All stored conversation comparisons are available in [model-evaluation](model-evaluation/); the language controls record paired Banglish, Bangla-script, and English results.

The tested prompt is in the runner's `refined` function. This investigation added the report, artifacts, and diagnostic runner; it did not silently change the saved model, route real chats to the cloud, or apply an experimental prompt to the runtime. A future runtime integration needs the same transcript layout, explicit latest-turn grouping, model-specific thinking controls, and existing prompt-budget/freshness checks.
