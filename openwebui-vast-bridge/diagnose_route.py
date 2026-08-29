"""Safely report Vast autoscaler routing state without printing credentials."""

import asyncio
import json
from pathlib import Path

from vastai import CoroutineServerless


CONFIG_PATH = Path.home() / "AppData/Local/OpenWebUI/VastBridge/config.json"


async def main() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    async with CoroutineServerless(api_key=config["vast_api_key"]) as client:
        endpoint = await client.get_endpoint(config["endpoint"])
        print(f"endpoint_found={endpoint.name == config['endpoint']} id={endpoint.id}")
        request_idx = 0
        for attempt in range(1, 7):
            route = await endpoint._route(cost=4, req_idx=request_idx, timeout=15.0)
            request_idx = route.request_idx or request_idx
            print(
                f"attempt={attempt} status={route.status} "
                f"request_idx_present={bool(request_idx)}"
            )
            if route.status == "READY":
                return
            await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())
