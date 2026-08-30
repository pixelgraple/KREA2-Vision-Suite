# Open WebUI Vast bridge

This optional loopback-only bridge lets a local Open WebUI installation use
the private dedicated Qwen 3.8 gateway as an OpenAI-compatible model named
`heretic-3.8-q4-cloud`. A retained Serverless adapter remains available for
older operator configurations, but the production path is the dedicated GPU.

## Timeout policy

The default request timeout is **600 seconds (10 minutes)**. Dedicated requests
wait behind the shared Vision/Qwen FIFO and receive a normal OpenAI-compatible
response after any required model swap. The legacy Serverless streaming path
still emits an invisible SSE keepalive every 10 seconds during activation.
All paths remain bounded and return an error instead of hanging indefinitely.

## 32K context guard

Open WebUI keeps the complete raw conversation in its own history. Before each
cloud request, this bridge now measures the outbound context against the
model's 32K window. If the request is too large, it preserves the initial
instructions and newest turns, adds a short local digest of older turns, and
removes the older raw turns from that one outbound request. This prevents a
long chat from failing with `exceed_context_size_error`; it does not erase the
visible Open WebUI conversation. The default outbound input target is 12K
tokens so a long prompt can also finish prefill within the serverless request
deadline; the model itself still runs with its full 32K context allocation.

## Windows installation

1. Obtain the private gateway base URL and bridge bearer key from the operator.
2. Run `install-local.ps1` in PowerShell and configure `upstream_base_url` plus
   `upstream_api_key` in the protected local `config.json`.
4. In Open WebUI, add an OpenAI-compatible connection with base URL
   `http://127.0.0.1:11436/v1` and use the generated bridge key left on the
   clipboard.
5. Select `heretic-3.8-q4-cloud`.

The installer stores the Vast key in the current Windows user's local app-data
folder, restricts the configuration ACL to that user, and configures per-user
automatic startup. The bridge listens only on `127.0.0.1`; do not expose port
11436 publicly.

Run `diagnose_route.py` to inspect endpoint and worker availability without
sending a generation request. Run `python test_bridge_stream.py` to verify the
streaming adapter.

Never commit a populated `config.json`. Only `config.example.json` belongs in
source control.
