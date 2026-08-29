# Open WebUI Vast bridge

This optional loopback-only bridge lets a local Open WebUI installation use
the `local-openwebui-coding` Vast Serverless endpoint as an OpenAI-compatible
model named `heretic-3.8-q4-cloud`.

## Timeout policy

The default request timeout is **240 seconds (4 minutes)**. A Serverless
endpoint that remains at zero ready workers must return a timeout instead of
leaving Open WebUI waiting for 30 minutes. Long responses that are actively
streaming still need to finish within this request deadline.

## Windows installation

1. Create a dedicated Vast API key with only the permissions required for this
   endpoint.
2. Copy that key to the clipboard.
3. Run `install-local.ps1` in PowerShell.
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
