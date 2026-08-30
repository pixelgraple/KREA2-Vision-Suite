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
        +--> optional HTTPS gateway --> private dedicated RTX 3090 router
                                      |--> Gemma 4 Vision
                                      +--> Qwen 3.8 Prompt Editor / OpenWebUI
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

The llama.cpp provider launches a selected GGUF body with its matching multimodal projector. Quantization-specific IDs prevent telemetry or measured VRAM from one quantization being reused for another. The selected multimodal Qwen/Gemma model both observes the image and writes the resulting KREA2 prompt; no automatic second-stage prompter is installed or exposed.

### Dedicated dual-model worker

The online service uses one dedicated 24 GB RTX 3090. llama.cpp router mode exposes two pinned model presets but enforces `--models-max 1`, so Gemma Vision and Qwen Prompt Editor never compete for VRAM. A shared gateway lock serializes both product classes, and llama.cpp unloads the least-recent model before starting the other. The model API binds to worker loopback, requires a bearer key, and reaches the VPS only through a restricted reverse SSH listener on VPS loopback. Public clients can reach only the HTTPS gateway, which owns authentication, credit accounting, quotas, revocation, and abuse controls.

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

Local plugin submissions and local shared-FIFO tickets have no arbitrary admission deadline. They remain visible and cancellable while waiting behind Discord, Forge, or KreaForge work. At FIFO head, Vision owns the shared lock for the full interrogation, performs the queue-authenticated Forge/Ollama handoff, unloads its model before release, and then yields. Online Vision, Prompt Editor, and private OpenWebUI calls share a separate bounded FIFO on the dedicated GPU. A model change includes a bounded disk-to-VRAM load; same-model warm requests proceed without that swap.

## Release maintenance

The public plugin has no update checker or installer. Releases are manual full-package installs so the plugin and backend remain matched. If a Discord client update removes BetterDiscord, Repair checks the current `app-*` directory and reinjects BetterDiscord without changing the user's plugin settings.
