# Qwen3.8 27B Heretic Vast Serverless worker

Custom Vast PyWorker wrapper for the pinned public artifacts:

- `RVN-Q4_K_M-multilingual.gguf`
- `mmproj-Qwen3.8-27B-Q8_0.gguf`

The worker exposes `/v1/chat/completions` through Vast's authenticated
serverless router. The llama.cpp API remains bound to `127.0.0.1` inside the
worker. Model downloads are byte-counted and SHA-256 verified before startup.

Initial runtime policy:

- one GPU and one request at a time
- 32,768-token context
- Q8_0 KV cache
- full model and projector GPU offload
- startup health and real-inference checks before readiness
- fail-closed supervision after readiness

