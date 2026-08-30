import asyncio
import importlib.util
import json
import os
from contextlib import asynccontextmanager
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

    class DedicatedStreamResponse:
        status_code = 200
        headers = {"Content-Type": "text/event-stream; charset=utf-8"}

        def __init__(self):
            self.closed = False

        def iter_content(self, *, chunk_size):
            assert chunk_size == 256
            yield b'data: {"id":"chatcmpl-dedicated-proof","choices":[{"delta":{"role":"assistant","content":"DEDICATED_"},"finish_reason":null}]}\n\n'
            yield b'data: {"id":"chatcmpl-dedicated-proof","choices":[{"delta":{"content":"STREAM_OK"},"finish_reason":null}]}\n\n'
            yield b'data: {"id":"chatcmpl-dedicated-proof","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            yield b"data: [DONE]\n\n"

        def close(self):
            self.closed = True

    dedicated_response = DedicatedStreamResponse()

    @asynccontextmanager
    async def dedicated_stream(stream_payload):
        assert stream_payload["messages"][-1]["content"] == "complete file"
        assert stream_payload["stream"] is True
        try:
            yield dedicated_response
        finally:
            dedicated_response.close()

    bridge.UPSTREAM_BASE_URL = "https://gateway.invalid/v1/openwebui"
    bridge._dedicated_gateway_stream = dedicated_stream
    dedicated_chunks = [chunk async for chunk in bridge._sse_stream(payload, 8192)]
    dedicated_text = b"".join(dedicated_chunks).decode("utf-8")
    assert dedicated_text.count("data: [DONE]") == 1
    assert "DEDICATED_" in dedicated_text
    assert "STREAM_OK" in dedicated_text
    assert dedicated_text.count('"finish_reason":"stop"') == 1
    assert len(dedicated_chunks) == 4
    assert dedicated_response.closed is True
    print({"dedicated_stream": True, "content_deltas": 2, "done_markers": 1})


asyncio.run(main())
