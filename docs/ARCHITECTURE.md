# Architecture

## Trust boundaries

KREA2 Vision Suite separates Discord UI code, local privileged work, model inference, and optional network services.

```text
Discord + BetterDiscord
        |
        | literal loopback, authenticated session exchange
        v
Vision Studio on 127.0.0.1:7870
        |
        +--> local shared GPU FIFO --> llama.cpp/Ollama --> local model
        |
        +--> optional HTTPS worker client --> Vast Serverless model worker
        |
        +--> optional read-only KREA2 prompt sampler
        |
        +--> required privacy-minimal operational errors
        |
        +--> optional prompt contribution / rich failure diagnostics
```

The BetterDiscord process is treated as an untrusted UI client. It does not receive the operator's cloud credential, direct model-server credential, Forge handoff credential, or Seedframe service credential. Privileged routing remains in the local broker environment.

## Components

### BetterDiscord plugin

The plugin owns Discord rendering and user interaction:

- discovers supported attachment actions;
- enforces configured server allowlists;
- submits magnifier and Interrogate jobs;
- shows model selection, VRAM guidance, queue state, prompt history, and votes;
- obtains a short-lived one-use local session before each image POST.

It does not execute model inference or hold the remote worker's private API key.

### Vision Studio

Vision Studio is a FastAPI service bound to `127.0.0.1:7870`. It owns image validation, request-scoped preprocessing, model catalog/admission, provider routing, GPU coordination, evidence collection, prompt validation, and optional KREA2 traffic.

### Local models

The llama.cpp provider launches a selected GGUF body with its matching multimodal projector. Quantization-specific IDs prevent telemetry or measured VRAM from one quantization being reused for another. The optional Ollama route exists for legacy compatibility; modern Qwen/Gemma routes are not silently rewritten by the legacy prompter.

### Vast Serverless worker

The optional worker container starts a pinned model and projector on a 24 GB GPU. The local broker authenticates requests to the configured HTTPS endpoint. The worker processes request content in memory and returns model output. Public multi-user service still requires an operator gateway with per-user authentication, quotas, revocation, and abuse controls.

## Job lifecycle

1. The plugin validates the Discord source or manual upload.
2. It exchanges its loopback token for a request-bound one-use session.
3. Vision validates media type, dimensions, bytes, and request limits.
4. The job enters the FIFO.
5. Provider selection and VRAM admission occur after competing local GPU workloads are released.
6. Vision runs evidence passes, crops, audits, composition, and validation.
7. The result returns to the plugin and the queue ticket is released.
8. Request-scoped files are deleted.
9. Required privacy-minimal operational errors and optional contribution/rich diagnostics run under separate schemas and data boundaries.

## Shared GPU fairness

Discord performs one image per acquired queue ticket. If more Discord work remains, it returns at the tail. A 15-second warm model window is opportunistic only. A waiting non-Discord ticket cancels the window and forces eviction before that ticket proceeds.

Plugin-local submission waits, local shared-FIFO acquisition, and remote worker capacity each have a 30-second admission deadline. Capacity timeout becomes the exact terminal state `GPU not available`; the ticket is removed so later work can proceed. This deadline covers waiting for compute, not the inference time of a job that has already acquired a worker/GPU.

## Release maintenance

The public plugin has no update checker or installer. Releases are manual full-package installs so the plugin and backend remain matched. If a Discord client update removes BetterDiscord, Repair checks the current `app-*` directory and reinjects BetterDiscord without changing the user's plugin settings.
