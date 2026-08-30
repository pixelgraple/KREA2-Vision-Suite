# Dedicated dual-model Vast worker

This runtime keeps one reliable RTX 3090 online while serving both KREA2 Vision
and Qwen 3.8 through llama.cpp router mode. `--models-max 1` guarantees that
only one model is resident in VRAM. Requests name either
`gemma4-26b-a4b-heretic-q3-k-l` or `qwen38-27b-heretic-q4-k-m`; llama.cpp unloads
the previous model and loads the requested one when the workload changes.

The model API binds only to loopback and requires a generated bearer key. A
restricted reverse SSH tunnel exposes it only as `127.0.0.1:18090` on the VPS.
Neither llama.cpp nor its bearer key is publicly reachable.

`start-router.sh` verifies exact byte counts and SHA-256 hashes before loading
either model. `start-dedicated.sh` supervises both the router and tunnel;
`onstart.sh` launches it exactly once from Vast's persistent startup hook.
