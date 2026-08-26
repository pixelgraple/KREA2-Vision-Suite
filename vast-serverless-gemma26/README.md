# Vast Serverless Gemma 4 26B-A4B Heretic worker

This worker is deliberately pinned to one exact public model and projector:

- `gemma-4-26B-A4B-it-uncensored-heretic-Q3_K_L.gguf`
- `gemma-4-26B-A4B-it-mmproj-BF16.gguf`
- upstream revision `ea0259bf66bcd33b5f3425eb223932abaa0f4f07`

Both artifacts are verified by byte size and SHA-256 before `llama-server`
starts. A failed verification prevents the worker from becoming ready.

Recommended Vast pool and scaling configuration:

- exactly one 24 GB GPU per worker (RTX 3090 or RTX 4090 preferred; RTX A5000 or L4 also supported)
- at least 32 GB system RAM and **65 GB container disk**
- `max_workers=3` so bursts can use up to three paid GPUs
- `cold_workers=1` so one stopped worker keeps the 15 GB model cache
- `min_load=0` so no GPU remains active merely for idle capacity
- `inactivity_timeout=8` seconds after the final queued/running request
- `cold_mult=1`
- a hard offer ceiling chosen by the account owner before launch

An inactive worker does not incur GPU-compute charges, but Vast still charges
for its storage and bandwidth. Destroying the worker stops all billing but makes
the next cold start re-download and verify the artifacts.

The exact model pair occupies 15,019,315,424 bytes (about 14.0 GiB). The 65 GB
disk requirement leaves room for the CUDA/llama.cpp image, package layers, and
temporary download state. Request/model-server output is not written to the
persistent model volume. A small marker-only file under `/tmp` carries
model-ready/error lifecycle events to the Vast SDK; it never contains images,
prompts, or model responses.
Startup also checks free space before either
artifact download and keeps a separate 6 GiB reserve; insufficient storage fails
the worker cleanly instead of leaving a partial model.

The public route is `/v1/chat/completions`. Requests are strictly serialized;
the local BetterDiscord plugin never receives the Vast API key and continues to
talk only to Vision Studio at `127.0.0.1:7870`.

The root GitHub Actions workflow builds this directory as a dedicated
linux/amd64 image and publishes immutable commit and model tags to GHCR. Model
weights are never copied into the image; the worker downloads the two pinned,
hash-verified artifacts into its Vast cache on first startup.

The clean public repository publishes the worker as
`ghcr.io/pixelgraple/krea2-vision-suite-vast-gemma26`; this distinct package
name avoids inheriting permissions from the retired pre-release repository.

The production Vast template does not depend on private GHCR access. It uses
the same pinned public llama.cpp CUDA base image and runs
`bootstrap-worker.sh` from the immutable `krea2-worker-v0.13.9` source tag.
The bootstrap installs only the pinned Vast SDK plus download utilities, then
starts the same `worker.py` and hash-verifying model launcher contained in the
container image.
