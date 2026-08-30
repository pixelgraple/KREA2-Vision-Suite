import importlib.util
import os
from pathlib import Path


os.environ["VAST_OPENWEBUI_BRIDGE_CONFIG"] = str(
    Path.home() / "AppData/Local/OpenWebUI/VastBridge/config.json"
)
SOURCE = Path(__file__).with_name("bridge.py")
SPEC = importlib.util.spec_from_file_location("bridge_context_under_test", SOURCE)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


huge_history = []
for index in range(90):
    huge_history.append({"role": "user", "content": f"old request {index}: " + ("alpha beta gamma " * 1200)})
    huge_history.append({"role": "assistant", "content": f"old answer {index}: " + ("delta epsilon zeta " * 1200)})
    if index == 40:
        huge_history.append({"role": "system", "content": "LATE_SYSTEM_RULE_MUST_BE_HOISTED"})
huge_history.append({"role": "user", "content": "LATEST_USER_REQUEST_MUST_SURVIVE: fix only the final function."})

payload, max_tokens, stream, info = bridge._clean_payload({
    "model": bridge.MODEL,
    "messages": [
        {"role": "system", "content": "SYSTEM_RULE_MUST_SURVIVE: be a precise coding assistant."},
        *huge_history,
    ],
    "max_tokens": 8192,
    "stream": True,
})

assert stream is True
assert max_tokens == 8192
assert info["compacted"] is True
assert info["before_tokens"] > 180_000
assert info["after_tokens"] <= info["input_budget"]
assert info["input_budget"] == bridge.CONTEXT_TARGET_INPUT_TOKENS
assert info["input_budget"] + info["output_budget"] + bridge.CONTEXT_TEMPLATE_RESERVE_TOKENS <= bridge.MODEL_CONTEXT_TOKENS
joined = "\n".join(str(message.get("content") or "") for message in payload["messages"])
assert "SYSTEM_RULE_MUST_SURVIVE" in joined
assert "LATE_SYSTEM_RULE_MUST_BE_HOISTED" in joined
assert "LATEST_USER_REQUEST_MUST_SURVIVE" in joined
assert "Open WebUI history" in joined
assert payload["messages"][0]["role"] == "system"
assert sum(message.get("role") == "system" for message in payload["messages"]) == 1

short_payload, _, _, short_info = bridge._clean_payload({
    "model": bridge.MODEL,
    "messages": [{"role": "user", "content": "short request"}],
    "max_tokens": 256,
    "stream": False,
})
assert short_info["compacted"] is False
assert short_payload["messages"] == [{"role": "user", "content": "short request"}]

old_chat_payload, _, _, old_chat_info = bridge._clean_payload({
    "model": bridge.MODEL,
    "messages": [
        {"role": "system", "content": "ORIGINAL_SYSTEM_INSTRUCTION"},
        {"role": "user", "content": "Earlier question"},
        {"role": "assistant", "content": "Earlier answer"},
        {"role": "developer", "content": "LATER_DEVELOPER_INSTRUCTION"},
        {"role": "system", "content": "LATER_SYSTEM_INSTRUCTION"},
        {"role": "user", "content": "Continue this old chat"},
    ],
    "max_tokens": 512,
    "stream": True,
})
old_messages = old_chat_payload["messages"]
assert old_chat_info["compacted"] is False
assert old_messages[0]["role"] == "system"
assert sum(message.get("role") == "system" for message in old_messages) == 1
assert all(message.get("role") != "developer" for message in old_messages)
assert "ORIGINAL_SYSTEM_INSTRUCTION" in old_messages[0]["content"]
assert "LATER_DEVELOPER_INSTRUCTION" in old_messages[0]["content"]
assert "LATER_SYSTEM_INSTRUCTION" in old_messages[0]["content"]
assert old_messages[-1]["content"] == "Continue this old chat"

print({
    "before_tokens": info["before_tokens"],
    "after_tokens": info["after_tokens"],
    "input_budget": info["input_budget"],
    "retained_messages": len(payload["messages"]),
})
