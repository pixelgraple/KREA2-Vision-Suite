# Model choices and VRAM

The suite recognizes only the pinned body/projector combinations below. They are ordered by parameter size: larger models generally retain more visual detail, but need more VRAM and take longer. The body and multimodal projector must be placed in the same size folder without renaming.

| Selector | Exact body | Model card | Estimated allocation | Measured peak | Separate reserve | Admission requirement |
|---|---|---|---:|---:|---:|---:|
| 2B F16 | `Qwen-3-VL-2B-Instruct-heretic.f16.gguf` | [Hugging Face](https://huggingface.co/mradermacher/Qwen-3-VL-2B-Instruct-heretic-GGUF) | 6,144 MiB | 5,712 MiB | 4,096 MiB | 10,240 MiB |
| 4B Q8_0 | `Qwen3-VL-4B-Instruct-heretic.Q8_0.gguf` | [Hugging Face](https://huggingface.co/mradermacher/Qwen3-VL-4B-Instruct-heretic-GGUF) | 7,680 MiB | 7,092 MiB | 4,096 MiB | 11,776 MiB |
| 8B Q8_0 | `Qwen-3-VL-8B-Instruct-heretic.Q8_0.gguf` | [Hugging Face](https://huggingface.co/mradermacher/Qwen-3-VL-8B-Instruct-heretic-GGUF) | 13,312 MiB | 10,797 MiB | 4,096 MiB | 17,408 MiB |
| 9B GLM Abliterated Q5_K_M | `Huihui-GLM-4.6V-Flash-abliterated-Q5_K_M.gguf` | [Hugging Face](https://huggingface.co/AliBilge/Huihui-GLM-4.6V-Flash-abliterated) | 12,288 MiB | not measured | 4,096 MiB | 16,384 MiB |
| 12B Opus Q8_0 | `gemma-4-12B-it-uncensored-opus4.7-cot-Q8_0.gguf` | [Hugging Face](https://huggingface.co/Rangle2/gemma-4-12B-it-uncensored-opus4.7-cot) | 20,992 MiB | not measured on the bounded partial-offload profile | 4,096 MiB | 25,088 MiB |
| 12B Heretic Q8_0 | `gemma-4-12B-it-uncensored-heretic-Q8_0.gguf` | [Hugging Face](https://huggingface.co/llmfan46/gemma-4-12B-it-uncensored-heretic-GGUF) | 20,992 MiB | not measured on the bounded partial-offload profile | 4,096 MiB | 25,088 MiB |
| 26B-A4B Heretic Q3_K_L | `gemma-4-26B-A4B-it-uncensored-heretic-Q3_K_L.gguf` | [Hugging Face](https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF) | 24,576 MiB | not measured locally | 4,096 MiB | 28,672 MiB |
| 30B-A3B Abliterated Q2_K | `Qwen3-VL-30B-A3B-Instruct-abliterated.Q2_K.gguf` | [Hugging Face](https://huggingface.co/mradermacher/Qwen3-VL-30B-A3B-Instruct-abliterated-GGUF) | 18,432 MiB | not measured | 4,096 MiB | 22,528 MiB |
| 31B Heretic Q4_K_M | `gemma-4-31B-it-uncensored-heretic-Q4_K_M.gguf` | [Hugging Face](https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF) | 24,576 MiB | not measured | 4,096 MiB | 28,672 MiB |
| 32B Heretic Q4_K_M | `Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-Q4_K_M.gguf` | [Hugging Face](https://huggingface.co/llmfan46/Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-GGUF) | 26,624 MiB | not measured | 4,096 MiB | 30,720 MiB |

Measured peaks are installation-specific and are not promises for other GPUs, drivers, context sizes, or display loads. The 8B and every larger model exceed the suite's advisory 12 GiB model-allocation target. They remain selectable, but every real job must pass the post-Forge-unload capacity check.

## Exact pinned multimodal projectors

| Size | Projector | Bytes | SHA-256 |
|---|---|---:|---|
| 2B | `Qwen-3-VL-2B-Instruct-heretic.mmproj-Q8_0.gguf` | 445,053,696 | `b976865c9328f6af55f41e81d731338a3f2e0b1976a3dd51db836949aa7f8ed1` |
| 4B | `Qwen3-VL-4B-Instruct-heretic.mmproj-Q8_0.gguf` | 453,974,752 | `95a4eecc6288ba04694fada64d2c2b0552ae3f641aaffc0510b69ac6fe54cf81` |
| 8B | `Qwen-3-VL-8B-Instruct-heretic.mmproj-Q8_0.gguf` | 752,290,304 | `ac58c05e3bdc30b33d4e5e642c76cc305f298b0564900ab930e069662a3e8293` |
| 9B GLM | `Huihui-GLM-4.6V-Flash-abliterated.mmproj-Q8_0.gguf` | 1,030,387,776 | `5c28edff1192bbfcce3e57e6df44d2a3320708d592d6089778fa66187e46b8b0` |
| 12B Opus | `mmproj-gemma-4-12B-it-Q8_0.gguf` | 158,987,616 | `59e62255435dda870e2d1de97cc031330b31a898bac12b38a182cecff9cd3738` |
| 12B Heretic | `gemma-4-12B-it-uncensored-heretic-mmproj-BF16.gguf` | 175,115,328 | `260bf379fb313557642b51f55699530cf76d3b76555ca84b7ac7434873512cef` |
| 26B-A4B | `gemma-4-26B-A4B-it-mmproj-BF16.gguf` | 1,194,828,000 | `b3ee6c97d5a5bb1ae9eb93bf14c1d1b51a0179a45ac1076b195931814c759e1e` |
| 30B-A3B | `Qwen3-VL-30B-A3B-Instruct-abliterated.mmproj-Q8_0.gguf` | 712,149,440 | `fe92d9e473662224403e6f7e7446949fb4740f079b8b9765c0896adaf1a23615` |
| 31B | `gemma-4-31B-it-mmproj-BF16.gguf` | 1,200,726,208 | `21487ff26d08f7ddd1d654d3bbfc1ae1020aab3119f5bf654742ce4697732e4e` |
| 32B | `Qwen3-VL-32B-Instruct-mmproj-BF16.gguf` | 1,200,334,112 | `704973267ed68dc7d2316fb56aeaa4127679171725c2b6b196c2ab7c09fdf4c7` |

Body byte lengths, immutable revisions, direct download URLs, and SHA-256 values are pinned in `vision-studio/scripts/heretic_llamacpp_artifacts.json`. The Windows installer automatically downloads and verifies 8B by default; `-Model <ID>` chooses another pair. The lower-level runtime installer accepts `-DownloadModels <ID>`. No weights are stored or redistributed in this repository.
