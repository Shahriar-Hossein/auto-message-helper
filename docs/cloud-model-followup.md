# Nemotron 3 Super and GPT-OSS 120B Cloud follow-up — 2026-10-06

**Neither model displaced Gemma 4 31B Cloud for this particular Banglish/Chuckles workload in the tested configurations.** Both gave useful friendship and deadline replies, but practical questions still exposed language, speaker, and unsupported-action mistakes. Larger parameter counts did not make these tested replies consistently better.

This follow-up made **48 actual API calls**: eight fictional cases × three profiles × two models. The cases are exactly the ones from the [earlier comparison](model-response-evaluation.md), with no original private conversation content. The earlier report covers 99 calls separately; together the saved artifacts contain 147 records. This is a qualitative review of a small sample, not an automated accuracy score or a general model ranking. No browser model settings or runtime prompts were changed.

## Tested models and settings

Both requested cloud aliases were already registered in the local Ollama server; no large local model download was needed:

- `nemotron-3-super:cloud` — [official Ollama model page](https://ollama.com/library/nemotron-3-super:cloud).
- `gpt-oss:120b-cloud` — [official Ollama model page](https://ollama.com/library/gpt-oss:120b-cloud).

All profiles requested `temperature: 0.4`, `seed: 42`, and `num_ctx: 4096`. The [runner](../tools/compare-responses.cjs) defines the prompts and request options:

| Model | Profile | Thinking requested | Token budget |
| --- | --- | --- | ---: |
| Nemotron | `refined` | `false` | 256 |
| Nemotron | `refined-thinking` | `true` | 1024 |
| Nemotron | `focused-english` | `false` | 256 |
| GPT-OSS 120B | `refined` | `low` | 1024 |
| GPT-OSS 120B | `refined-medium` | `medium` | 1024 |
| GPT-OSS 120B | `focused-english` | `low` | 1024 |

The refined profiles use the same prompt that performed best with Gemma. `focused-english` understands the original Banglish input but requests English replies; it also uses the focused prompt and different examples. It is therefore not an isolated experiment in output language. No baseline 128-token production request was tested for these two models. GPT-OSS reasoning controls use named levels; see [Ollama thinking controls](https://docs.ollama.com/capabilities/thinking).

## Nemotron 3 Super

With thinking disabled, all eight replies completed and the friendship/two-topic replies were relevant. However, the demo answer misread the request, the money answer promised to collect the balance, and the call/library answer mostly repeated the question. The English friendship question received Banglish despite the language-matching instruction.

Thinking produced seven completed replies and one empty answer that hit the 1,024-token limit. It did not consistently improve the content: the call answer still invented a position about the earlier call, the money reply became a generic acknowledgement in English, and several jokes were awkward or unrelated. The English friendship reply also invented the owner's coffee habit.

The English-output profile was clearer in several cases but still invented important facts. It said the owner would attend the demo **tomorrow**, although the incoming request said **next week** and attendance was unconfirmed. It also claimed Chuckles received the money and would notify the owner. Those statements are unsupported by the conversation or the extension's capabilities.

Bangla is absent from the supported-language list on the [official model page](https://ollama.com/library/nemotron-3-super:cloud). That is a reason to test Banglish carefully; it does not prove the cause of the errors or mean the model cannot handle any Bangla.

## GPT-OSS 120B

All 24 requests completed under the supplied 1,024-token budget. Completion did not establish correctness. With low reasoning and the refined prompt, the model invented a demo arrangement, asserted an unverified earlier call, and mixed first-person Chuckles/owner wording in friendship replies. Friendship reassurance also leaked into unrelated work and call messages despite the prompt's restriction.

Medium reasoning corrected the call uncertainty in that one case, but still promised to check the owner's schedule and get back to the recipient. The money reply ignored the payment update completely and returned a friendship/battery joke. The unknown-deadline reply also promised the owner would provide an update, which was not stated in the chat.

English output gave a good call/library acknowledgement and correctly admitted the unknown deadline. However, it still promised to notify the owner about the balance, and it mistranslated Banglish `successful hole` (meaning “if successful”) as an English “successful hole” in the two-topic reply. It did not reliably outperform the previously tested Gemma combination.

## Actual reply examples

These are the model-generated bodies; the extension's existing parser adds the fixed Chuckles introduction.

| Model/profile | Case | Actual reply | Assessment |
| --- | --- | --- | --- |
| `nemotron-3-super:cloud` / `refined` | remember-friends | Bhulbe keno? My hooman bondhuder kokhono bhule na, successful hole o same! 😄 | Relevant friendship reassurance |
| `nemotron-3-super:cloud` / `focused-english` | demo-request | My hooman will be at the office tomorrow for the demo—let me know what time works for you. | Invented tomorrow and attendance |
| `nemotron-3-super:cloud` / `focused-english` | money-update | Great, I got the 300. I’ll let my hooman know about the extra 200 for Thursday. | Wrong speaker and unsupported notification |
| `gpt-oss:120b-cloud` / `refined` | call-and-library | Call ta age dewa hoyeche, ar library te thaka bhalo—my hooman bondhuder moto kokhono bhule na! 😄 | Asserted an unverified call and unrelated friendship theme |
| `gpt-oss:120b-cloud` / `refined-medium` | money-update | Don’t worry, my hooman never forgets a friend 😊. Even my hooman’s memory beats my phone’s battery life! | Ignored the payment update |
| `gpt-oss:120b-cloud` / `focused-english` | two-topic-burst | My hooman won’t forget the successful hole, and it’s good to hear the network is working now. 😄 | Misread Banglish “hole” as an English noun |
| `gpt-oss:120b-cloud` / `focused-english` | call-and-library | I’m not sure about a prior call, and I see you’re at the library now. | Appropriate uncertainty and recipient attribution |

## Completion and observed latency

Every API request returned HTTP 200. The one incomplete request was Nemotron's thinking-mode demo case. Hidden `message.thinking` text was not collected; artifacts only record whether it was present. The runner's diagnostic timeout is 60 seconds, while the extension's timeout is 25 seconds. All observed follow-up calls finished below 25 seconds, including the length-limited reply; that does not make the incomplete reply usable.

The profiles ran interleaved, so these timings include possible contention and network variation. They are not a controlled speed comparison with each other or with Gemma's earlier run. “Usable completion” below only means a nonempty, normally stopped answer accepted by the reply parser, not semantic correctness.

| Model | Profile | Usable completion | Length limits | Median | Range |
| --- | --- | ---: | ---: | ---: | --- |
| Nemotron 3 Super | `refined` | 8/8 | 0 | 1.34s | 0.96–2.60s |
| Nemotron 3 Super | `refined-thinking` | 7/8 | 1 | 8.97s | 6.28–10.44s |
| Nemotron 3 Super | `focused-english` | 8/8 | 0 | 8.32s | 1.12–10.84s |
| GPT-OSS 120B | `refined` | 8/8 | 0 | 1.35s | 0.73–2.76s |
| GPT-OSS 120B | `refined-medium` | 8/8 | 0 | 8.97s | 2.51–10.65s |
| GPT-OSS 120B | `focused-english` | 8/8 | 0 | 7.83s | 1.22–11.30s |

## Recommendation and repeat commands

Keep **Gemma 4 31B Cloud, thinking disabled, and the refined prompt** as the strongest tested option for these short Banglish replies. Its earlier demo/payment answers were still vague, so the comparison does not establish flawless production behavior. Neither of these two additional models provides evidence that a model switch alone will fix the extension's reply quality.

The six new JSON result files are in [model-evaluation](model-evaluation/). To repeat these exact fictional tests through your local Ollama server:

```bash
node tools/compare-responses.cjs nemotron-3-super:cloud refined
node tools/compare-responses.cjs nemotron-3-super:cloud refined-thinking
node tools/compare-responses.cjs nemotron-3-super:cloud focused-english
node tools/compare-responses.cjs gpt-oss:120b-cloud refined
node tools/compare-responses.cjs gpt-oss:120b-cloud refined-medium
node tools/compare-responses.cjs gpt-oss:120b-cloud focused-english
```

These aliases route the fictional benchmark prompts to Ollama Cloud. The investigation records the results without applying experimental prompts or changing the user's selected model.
