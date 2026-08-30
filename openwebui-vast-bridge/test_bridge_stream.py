import asyncio
import importlib.util
import json
import os
from pathlib import Path


os.environ["VAST_OPENWEBUI_BRIDGE_CONFIG"] = str(
    Path.home() / "AppData/Local/OpenWebUI/VastBridge/config.json"
)
SOURCE = Path(__file__).with_name("bridge.py")
SPEC = importlib.util.spec_from_file_location("bridge_under_test", SOURCE)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class Events:
    def __init__(self, events):
        self.events = events

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for event in self.events:
            yield event


class Endpoint:
    requests = []

    async def request(self, route, payload, **kwargs):
        self.requests.append(payload)
        if len(self.requests) == 1:
            await asyncio.sleep(0.015)
        fence = "`" * 3
        if len(self.requests) == 1:
            events = [
                {"choices": [{"delta": {"content": fence + "python\nx = 1"}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            ]
        else:
            events = [
                {"choices": [{"delta": {"content": "\n" + fence}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            ]
        return {"response": Events(events)}


class Client:
    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get_endpoint(self, endpoint):
        return Endpoint()


async def main():
    bridge.CoroutineServerless = Client
    # This branch explicitly exercises the retained Serverless fallback even
    # when the operator's installed config selects the dedicated gateway.
    bridge.UPSTREAM_BASE_URL = ""
    bridge.SSE_KEEPALIVE_SECONDS = 0.005
    Endpoint.requests.clear()
    payload = {
        "model": bridge.MODEL,
        "messages": [{"role": "user", "content": "complete file"}],
        "max_tokens": 8192,
        "stream": True,
    }
    chunks = [chunk async for chunk in bridge._sse_stream(payload, 8192)]
    text = b"".join(chunks).decode("utf-8")
    assert len(Endpoint.requests) == 2
    assert text.count("data: [DONE]") == 1
    assert ": krea2-worker-warming" in text
    assert "x = 1" in text
    assert len(Endpoint.requests[1]["messages"]) == 3
    assert Endpoint.requests[1]["messages"][1]["role"] == "assistant"
    terminal_reasons = []
    for block in text.split("\n\n"):
        if not block.startswith("data: {"):
            continue
        event = json.loads(block[6:])
        choices = event.get("choices") or []
        if choices and choices[0].get("finish_reason") is not None:
            terminal_reasons.append(choices[0]["finish_reason"])
    assert terminal_reasons == ["stop"]
    print({"segments": 2, "terminal_reasons": terminal_reasons, "done_markers": 1})

    async def dedicated_response(payload, cost, *, stream):
        assert payload["messages"][-1]["content"] == "complete file"
        assert cost == 8192
        assert stream is False
        return {
            "ok": True,
            "response": {
                "id": "chatcmpl-dedicated-proof",
                "choices": [{"message": {"content": "DEDICATED_STREAM_OK"}}],
            },
        }

    bridge.UPSTREAM_BASE_URL = "https://gateway.invalid/v1/openwebui"
    bridge._request_vast = dedicated_response
    dedicated_chunks = [chunk async for chunk in bridge._sse_stream(payload, 8192)]
    dedicated_text = b"".join(dedicated_chunks).decode("utf-8")
    assert dedicated_text.count("data: [DONE]") == 1
    assert "DEDICATED_STREAM_OK" in dedicated_text
    assert dedicated_text.count('"finish_reason": "stop"') == 1
    print({"dedicated_stream": True, "done_markers": 1})


asyncio.run(main())
