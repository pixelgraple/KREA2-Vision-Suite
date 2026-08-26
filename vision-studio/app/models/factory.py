from pathlib import Path

from ..config import ROOT, Settings
from ..services.model_catalog import ModelSpec, resolve_model
from .llama_cpp_provider import LlamaCppProvider
from .ollama_provider import OllamaProvider
from .openai_compatible_provider import OpenAICompatibleProvider
from .vast_serverless_provider import VastServerlessProvider


def provider_for(settings: Settings, spec: ModelSpec | None = None, telemetry_callback=None):
    """Construct a provider from a server-resolved model specification."""

    backend = settings.backend.lower()
    if spec is None and backend in {"openai", "openai_compatible"}:
        return OpenAICompatibleProvider(
            settings.api_base,
            settings.api_key,
            settings.model,
            settings.max_output_tokens,
        )
    selected = spec or resolve_model(settings.model, settings)
    context = min(settings.context_length, selected.context_cap)
    max_tokens = min(settings.max_output_tokens, selected.max_output_cap, context - 1)
    if selected.backend == "ollama":
        return OllamaProvider(
            settings.api_base,
            selected.provider_model,
            context,
            max_tokens,
            settings.keep_alive,
        )
    if selected.backend == "llama_cpp":
        if selected.server_exe is None or selected.model_path is None or selected.mmproj_path is None:
            raise RuntimeError("The selected llama.cpp model is not available locally.")
        telemetry_path = Path(settings.llama_cpp_telemetry_path).expanduser()
        if not telemetry_path.is_absolute():
            telemetry_path = ROOT / telemetry_path
        gemma4_vision = selected.provider_model.startswith("gemma4-")
        gemma4_12b = selected.provider_model.startswith("gemma4-12b-")
        return LlamaCppProvider(
            server_exe=selected.server_exe,
            model_path=selected.model_path,
            mmproj_path=selected.mmproj_path,
            alias=selected.provider_model,
            host="127.0.0.1",
            port=settings.llama_cpp_port,
            context=context,
            max_tokens=max_tokens,
            startup_timeout=settings.llama_cpp_startup_timeout_seconds,
            telemetry_callback=telemetry_callback,
            runtime_log_path=telemetry_path.parent / "llama_cpp_server.log",
            # Gemma 4 CUDA projector inference can hard-crash on RTX 5090.
            # Keep only that projector on CPU and bound dynamic image tokens;
            # the language model layers remain fully GPU-offloaded.
            mmproj_offload=not gemma4_vision,
            image_min_tokens=256 if gemma4_vision else None,
            image_max_tokens=256 if gemma4_vision else 4096,
            image_max_side=768 if gemma4_vision else None,
            # Eight CPU-resident transformer layers keep Gemma 4 12B below
            # the measured all-GPU footprint while preserving the 4 GiB
            # shared-machine safety reserve. Other model families stay fully
            # GPU-offloaded.
            gpu_layers=40 if gemma4_12b else "all",
        )
    if selected.backend == "vast_serverless":
        python_exe = Path(settings.vast_serverless_python_exe).expanduser()
        if not python_exe.is_absolute():
            python_exe = ROOT / python_exe
        return VastServerlessProvider(
            endpoint=settings.vast_serverless_endpoint,
            api_key=settings.vast_serverless_api_key,
            model=selected.provider_model,
            max_tokens=max_tokens,
            timeout=settings.vast_serverless_request_timeout_seconds,
            python_exe=python_exe,
            bridge_script=ROOT / "app" / "models" / "vast_serverless_client.py",
        )
    if selected.backend in {"openai", "openai_compatible"}:
        return OpenAICompatibleProvider(
            settings.api_base,
            settings.api_key,
            selected.provider_model,
            max_tokens,
        )
    raise RuntimeError(f"Unsupported Vision backend '{selected.backend}'.")
