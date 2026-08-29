from __future__ import annotations
import hmac, ipaddress, json, logging, os, secrets, tempfile, threading
from pathlib import Path
from typing import Annotated
from fastapi import APIRouter, File, Form, Header, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from ..config import ROOT, settings
from ..schemas.prompt import PromptControls, StudioState
from ..services.history import PresetStore
from ..services.image_processor import ImageProcessor
from ..services.pipeline import (
    GpuCapacityError,
    StudioPipeline,
    VRAM_ADMISSION_JITTER_MB,
    gpu_capacity_requirements,
)
from ..services.discord_vision import (
    DiscordDescribeResponse,
    DiscordVisionBackendError,
    DiscordVisionCancelled,
    DiscordVisionDatasetUnavailable,
    DiscordVisionRejected,
    DiscordVisionSafetyRejected,
    DiscordVisionService,
    HERETIC_MODEL_IDS,
    LEGACY_MODEL_ID,
    MODEL_LABEL,
    PIPELINE_ID,
)
from ..services.forge_vram_handoff import ForgeHandoffError
from ..services.shared_queue import SharedGpuUnavailableError
from ..services.feedback_guidance import parse_feedback_context
from ..services.discord_jobs import DiscordVisionJobStore
from ..services.discord_sessions import DiscordVisionSessionStore
from ..models.remote_access import RemoteAccess
from ..models.llama_cpp_provider import LlamaCppProviderError
from ..models.remote_gateway_provider import (
    RemoteGatewayErrorReporter,
    RemoteGatewayProviderError,
    fetch_remote_gateway_health,
)
from ..services.model_catalog import available_model_specs, public_model_statuses
from ..services.model_downloads import ModelDownloadBusy, ModelDownloadError, ModelDownloadManager
from ..services.release_updates import ReleaseUpdateManager, SuiteUpdateBusy, SuiteUpdateError
from ..services.gpu_telemetry import GpuTelemetryError, MeasuredPeakStore, query_gpu_memory
from ..services.krea2_contributions import (
    CONTRIBUTION_TERMS_VERSION,
    Krea2ContributionError,
    Krea2PromptContributor,
)
from ..services.krea2_diagnostics import (
    DIAGNOSTIC_TERMS_VERSION,
    Krea2DiagnosticReporter,
    Krea2OperationalErrorReporter,
    sanitize_operational_error,
)
from ..services.discord_error_reports import exception_trace, redact_technical_trace

router=APIRouter(prefix="/api")
pipeline=StudioPipeline(settings); presets=PresetStore(ROOT); discord_vision=DiscordVisionService(settings)
discord_jobs=DiscordVisionJobStore(ROOT)
discord_sessions=DiscordVisionSessionStore()
model_downloads=ModelDownloadManager(settings)

def discord_update_busy() -> bool:
    summary=discord_jobs.summary()
    return bool(int(summary.get("queued") or 0) or int(summary.get("running") or 0))

suite_updates=ReleaseUpdateManager(
    ROOT,
    busy_check=discord_update_busy,
    automatic_install_supported=os.name == "nt",
)
krea2_contributor=(
    Krea2PromptContributor(settings.discord_vision_token)
    if len(settings.discord_vision_token.encode("utf-8")) >= 32
    else None
)
krea2_diagnostic_reporter=(
    Krea2DiagnosticReporter(settings.discord_vision_token)
    if len(settings.discord_vision_token.encode("utf-8")) >= 32
    else None
)
krea2_operational_error_reporter=(
    Krea2OperationalErrorReporter(settings.discord_vision_token)
    if len(settings.discord_vision_token.encode("utf-8")) >= 32
    else None
)
remote_discord_error_reporter=(
    RemoteGatewayErrorReporter(
        base_url=settings.remote_gateway_url,
        origin_ip=settings.remote_gateway_origin_ip,
    )
    if settings.remote_gateway_url
    else None
)
BACKEND_VERSION=(ROOT / "VERSION").read_text(encoding="utf-8").strip() or "unknown"
log=logging.getLogger("studio.api")

def readable_error(exc: Exception):
    message=str(exc)
    lowered=message.lower()
    if "out of memory" in lowered or "cuda" in lowered and "memory" in lowered: message="GPU memory is exhausted. Let Forge finish, use a smaller Qwen3-VL model, or lower QWEN_CONTEXT_LENGTH."
    raise HTTPException(422,message)

def backend_public_failure(exc: Exception, requested_model: str) -> tuple[str,str,str]:
    messages=[]
    chain=[]
    current: BaseException | None=exc
    seen=set()
    while current is not None and id(current) not in seen and len(messages)<5:
        seen.add(id(current))
        chain.append(current)
        messages.append(str(current))
        current=current.__cause__ or current.__context__
    detail=" ".join(messages)
    lowered=detail.casefold()
    capacity_error=next((item for item in chain if isinstance(item,GpuCapacityError)),None)
    if capacity_error is not None:
        public=f"GPU not available: {sanitize_operational_error(str(capacity_error))}"
        return "GPU not available",public,public
    if requested_model.startswith("vast::"):
        if "gpu not available" in lowered:
            public="Online Vision could not reach its remote GPU. Your local GPU was not used."
            return "Online Vision unavailable",public,public
        if ("timed out" in lowered or "timeout" in lowered) and ("worker" in lowered or "ready" in lowered or "queue" in lowered):
            public="Online Vision timed out while waiting for its remote GPU. Your local GPU was not used."
            return "Online Vision unavailable",public,public
        actionable=next((item for item in chain if isinstance(item,RemoteGatewayProviderError)),exc)
        public=f"Remote Vision error: {sanitize_operational_error(str(actionable))}"
        return "Remote Vision failed",public,public
    if "gpu not available" in lowered:
        return "GPU not available","GPU not available","GPU not available"
    actionable=next((item for item in chain if isinstance(item,LlamaCppProviderError)),exc)
    public=f"Local Vision error: {sanitize_operational_error(str(actionable))}"
    return (
        "Local Vision failed",
        public,
        public,
    )

async def prepared_upload(upload: UploadFile):
    suffix=Path(upload.filename or "image.jpg").suffix.lower()
    maximum=settings.max_upload_mb*1024*1024
    work=tempfile.TemporaryDirectory(prefix="krea2-studio-"); source=Path(work.name)/f"upload{suffix}"
    try:
        total=0
        with source.open("wb") as handle:
            while chunk := await upload.read(1024*1024):
                total += len(chunk)
                if total > maximum: raise HTTPException(413,f"Upload exceeds {settings.max_upload_mb} MB.")
                handle.write(chunk)
        if total == 0: raise HTTPException(422,"Upload is empty.")
        image,digest=ImageProcessor(settings.max_upload_mb*1024*1024,settings.max_image_pixels,settings.max_image_side).prepare(source,Path(work.name)); return work,image,digest
    except Exception:
        work.cleanup(); raise
    finally:
        await upload.close()

def require_loopback(request: Request, detail: str) -> None:
    peer=request.client.host if request.client else ""
    requested_host=request.url.hostname or ""
    try:
        peer_loopback=ipaddress.ip_address(peer).is_loopback
        host_loopback=ipaddress.ip_address(requested_host).is_loopback
    except ValueError:
        peer_loopback=host_loopback=False
    if not peer_loopback or not host_loopback: raise HTTPException(403,detail)

def require_discord_vision_auth(request: Request, supplied: str | None, configured: str) -> None:
    if len(configured.encode("utf-8")) < 32:
        raise HTTPException(503,"Discord vision is not configured.")
    require_loopback(request,"Discord vision accepts literal loopback clients only.")
    supplied_bytes=(supplied or "").encode("utf-8")
    if not hmac.compare_digest(supplied_bytes,configured.encode("utf-8")):
        raise HTTPException(401,"Invalid Discord vision token.")

def require_discord_vision_session(
    request: Request,
    supplied: str | None,
    configured: str,
    idempotency_key: str | None,
    collector_version: str | None,
    model: str,
) -> object:
    if len(configured.encode("utf-8")) < 32:
        raise HTTPException(503,"Discord vision is not configured.")
    require_loopback(request,"Discord vision accepts literal loopback clients only.")
    session=discord_sessions.consume_record(
        supplied or "",
        idempotency_key or "",
        collector_version or "",
        model,
    )
    if session is None:
        raise HTTPException(401,"Invalid or expired one-use Discord vision session.")
    return session

def track_job(method, *args, **kwargs):
    try: return method(*args,**kwargs)
    except Exception as exc:
        log.warning("discord dashboard state update failed (%s)",type(exc).__name__)
        return None

def schedule_failure_diagnostic(
    reporter: Krea2DiagnosticReporter | None,
    image_path: Path | None,
    job_id: str | None,
    enabled: bool,
    discord_username: str,
    model_id: str,
    plugin_version: str | None,
    error_code: str,
    error_message: str,
    stage: str,
    error: Exception,
) -> None:
    """Copy only consented failure evidence to memory for post-response upload."""

    if not enabled or reporter is None or image_path is None or not job_id:
        return
    try:
        image_bytes=image_path.read_bytes()
    except OSError as exc:
        log.warning("optional diagnostic image could not be read job=%s reason=%s",job_id,type(exc).__name__)
        return
    prompt=getattr(error,"diagnostic_prompt",None)
    start_background_task(
        reporter.submit_safely,
        image_bytes=image_bytes,
        job_id=job_id,
        discord_username=discord_username,
        model_id=model_id,
        pipeline_id=PIPELINE_ID,
        error_code=error_code,
        error_message=error_message,
        stage=stage,
        prompt_text=prompt if isinstance(prompt,str) and prompt.strip() else None,
        plugin_version=str(plugin_version or "unknown"),
        backend_version=BACKEND_VERSION,
    )

def schedule_operational_error(
    *,
    event_id: str | None,
    model_id: str,
    plugin_version: str | None,
    error_code: str,
    error_message: str,
    stage: str,
) -> None:
    """Always queue privacy-minimal technical telemetry; never user content."""

    if krea2_operational_error_reporter is None:
        return
    normalized_event=str(event_id or "").strip().lower()
    if len(normalized_event) != 32 or any(ch not in "0123456789abcdef" for ch in normalized_event):
        normalized_event=secrets.token_hex(16)
    start_background_task(
        krea2_operational_error_reporter.submit_safely,
        event_id=normalized_event,
        model_id=model_id or "unknown",
        pipeline_id=PIPELINE_ID,
        error_code=error_code,
        error_message=error_message,
        stage=stage,
        runtime="remote" if str(model_id).startswith("vast::") else "local",
        plugin_version=str(plugin_version or "unknown"),
        backend_version=BACKEND_VERSION,
    )

def schedule_discord_error_report(
    *,
    event_id: str | None,
    model_id: str,
    plugin_version: str | None,
    error_code: str,
    error_message: str,
    stage: str,
    technical_trace: str,
    license_id: str,
    license_token: str,
) -> None:
    """Queue one redacted .txt report through the gateway-owned webhook."""

    if remote_discord_error_reporter is None:
        return
    normalized_event=str(event_id or "").strip().lower()
    if len(normalized_event) != 32 or any(ch not in "0123456789abcdef" for ch in normalized_event):
        normalized_event=secrets.token_hex(16)
    start_background_task(
        remote_discord_error_reporter.submit_safely,
        license_id=str(license_id or ""),
        license_token=str(license_token or ""),
        event_id=normalized_event,
        model_id=model_id or "unknown",
        pipeline_id=PIPELINE_ID,
        error_code=error_code,
        error_message=sanitize_operational_error(error_message,2000),
        stage=sanitize_operational_error(stage,200),
        runtime="remote" if str(model_id).startswith("vast::") else "local",
        plugin_version=str(plugin_version or "unknown"),
        backend_version=BACKEND_VERSION,
        technical_trace=redact_technical_trace(technical_trace),
    )

def start_background_task(function, **kwargs) -> None:
    threading.Thread(target=function,kwargs=kwargs,daemon=True,name="krea2-diagnostic-upload").start()

def strict_form_flag(value: str, field_name: str) -> bool:
    normalized = str(value or "").strip().lower()
    if normalized in {"1", "true", "on"}:
        return True
    if normalized in {"0", "false", "off"}:
        return False
    raise HTTPException(422, f"{field_name} must be 0 or 1.")

@router.get("/discord-jobs")
def discord_job_list(
    request:Request,
    response:Response,
    page:int=1,
    page_size:int=20,
    view:str="recent",
    q:str="",
    model:str="",
    limit:int|None=None,
):
    require_loopback(request,"Discord Vision job history is available on literal loopback only.")
    response.headers["Cache-Control"]="no-store"
    try:
        history=discord_jobs.list_page(
            page=page,
            page_size=limit if limit is not None else page_size,
            view=view,
            query=q,
            model=model,
        )
    except (TypeError,ValueError) as exc:
        raise HTTPException(422,str(exc)) from exc
    return {
        "summary":discord_jobs.summary(),
        "queue":discord_vision.queue.status(),
        "scheduler":discord_vision.scheduler_status(),
        **history,
    }

@router.get("/discord-jobs/{job_id}")
def discord_job_detail(job_id:str,request:Request,response:Response):
    require_loopback(request,"Discord Vision job history is available on literal loopback only.")
    response.headers["Cache-Control"]="no-store"
    item=discord_jobs.get(job_id)
    if not item: raise HTTPException(404,"Discord Vision job was not found.")
    return item

@router.post("/discord-jobs/{job_id}/cancel")
def discord_job_cancel(
    job_id:str,
    request:Request,
    token:Annotated[str|None,Header(alias="X-Krea2-Vision-Token")]=None,
):
    require_discord_vision_auth(request,token,settings.discord_vision_token)
    item=discord_jobs.get(job_id)
    if not item: raise HTTPException(404,"Discord Vision job was not found.")
    accepted=discord_jobs.request_cancel(job_id)
    return {"accepted":accepted,"job":discord_jobs.get(job_id)}

@router.post("/discord-jobs-clear-terminal")
def discord_jobs_clear_terminal(
    request:Request,
    token:Annotated[str|None,Header(alias="X-Krea2-Vision-Token")]=None,
):
    require_discord_vision_auth(request,token,settings.discord_vision_token)
    return {"cleared":discord_jobs.clear_terminal()}

class DiscordSessionRequest(BaseModel):
    idempotency_key:str
    model:str
    remote_license_id:str=""
    remote_license_token:str=""
    remote_discord_user_id:str=""
    remote_discord_username:str=""
    source_url:str=""

class DiscordOperationalErrorRequest(BaseModel):
    event_id:str
    model_id:str
    error_code:str
    error_message:str
    stage:str
    technical_trace:str="No plugin traceback was supplied."

@router.post("/discord-errors")
def discord_operational_error(
    payload:DiscordOperationalErrorRequest,
    request:Request,
    token:Annotated[str|None,Header(alias="X-Krea2-Vision-Token")]=None,
    collector_version:Annotated[str|None,Header(alias="X-Krea2-Collector-Version")]=None,
    remote_license_id:Annotated[str|None,Header(alias="X-Krea2-Remote-License-Id")]=None,
    remote_license_token:Annotated[str|None,Header(alias="X-Krea2-Remote-License-Token")]=None,
):
    require_discord_vision_auth(request,token,settings.discord_vision_token)
    if len(payload.event_id) != 32 or any(ch not in "0123456789abcdef" for ch in payload.event_id):
        raise HTTPException(422,"Operational event ID is invalid.")
    if not (1 <= len(payload.model_id) <= 200 and 1 <= len(payload.error_code) <= 80 and 1 <= len(payload.error_message) <= 2000 and 1 <= len(payload.stage) <= 200 and 1 <= len(payload.technical_trace) <= 131072):
        raise HTTPException(422,"Operational error fields are invalid.")
    operational_accepted=False
    if krea2_operational_error_reporter is not None:
        operational_accepted=krea2_operational_error_reporter.submit_safely(
            event_id=payload.event_id,
            model_id=payload.model_id,
            pipeline_id=PIPELINE_ID,
            error_code=payload.error_code,
            error_message=payload.error_message,
            stage=payload.stage,
            runtime="remote" if payload.model_id.startswith("vast::") else "local",
            plugin_version=str(collector_version or "unknown"),
            backend_version=BACKEND_VERSION,
        )
    webhook_accepted=False
    if remote_discord_error_reporter is not None and remote_license_id and remote_license_token:
        webhook_accepted=remote_discord_error_reporter.submit_safely(
            license_id=remote_license_id,
            license_token=remote_license_token,
            event_id=payload.event_id,
            model_id=payload.model_id,
            pipeline_id=PIPELINE_ID,
            error_code=payload.error_code,
            error_message=sanitize_operational_error(payload.error_message,2000),
            stage=sanitize_operational_error(payload.stage,200),
            runtime="remote" if payload.model_id.startswith("vast::") else "local",
            plugin_version=str(collector_version or "unknown"),
            backend_version=BACKEND_VERSION,
            technical_trace=redact_technical_trace(payload.technical_trace),
        )
    if not operational_accepted and not webhook_accepted:
        raise HTTPException(503,"Operational error reporting is temporarily unavailable.")
    return {
        "accepted":True,
        "webhook_attachment":webhook_accepted,
        "privacy":"no image, prompt, Discord identity, URL, filename, credential, or local user path collected",
    }

@router.post("/discord-session")
def issue_discord_session(
    payload:DiscordSessionRequest,
    request:Request,
    response:Response,
    token:Annotated[str|None,Header(alias="X-Krea2-Vision-Token")]=None,
    collector_version:Annotated[str|None,Header(alias="X-Krea2-Collector-Version")]=None,
):
    require_discord_vision_auth(request,token,settings.discord_vision_token)
    if not suite_updates.accepting_new_jobs():
        raise HTTPException(503,"A verified KREA2 Vision Suite update is waiting for Vision to become idle.")
    try:
        remote_access=None
        if payload.model.strip().startswith("vast::"):
            remote_access=RemoteAccess(
                license_id=payload.remote_license_id.strip(),
                license_token=payload.remote_license_token.strip(),
                discord_user_id=payload.remote_discord_user_id.strip(),
                discord_username=" ".join(payload.remote_discord_username.split()),
                request_id=payload.idempotency_key.strip().lower(),
                source_url=payload.source_url.strip(),
            )
        session_token,expires_in=discord_sessions.issue(
            payload.idempotency_key,
            collector_version or "",
            payload.model,
            remote_access,
        )
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc
    response.headers["Cache-Control"]="no-store"
    return {
        "session_token":session_token,
        "expires_in_seconds":expires_in,
        "one_time":True,
    }

@router.post("/discord-describe",response_model=DiscordDescribeResponse)
async def discord_describe(
    request:Request,
    image:UploadFile=File(...),
    model:str=Form(""),
    guidance:str=Form(""),
    dataset_guidance:str=Form("0"),
    feedback_context:str=Form(""),
    analysis_profile:str=Form("fast"),
    prompt_count:int=Form(1),
    job_id:str=Form(""),
    contribution_terms:str=Form(""),
    diagnostic_terms:str=Form(""),
    diagnostic_username:str=Form(""),
    session_token:Annotated[str|None,Header(alias="X-Krea2-Vision-Session")]=None,
    idempotency_key:Annotated[str|None,Header(alias="X-Idempotency-Key")]=None,
    collector_version:Annotated[str|None,Header(alias="X-Krea2-Collector-Version")]=None,
):
    requested_model=model.strip() or settings.model
    if not suite_updates.accepting_new_jobs():
        raise HTTPException(503,"A verified KREA2 Vision Suite update is being installed. Retry shortly.")
    vision_session=require_discord_vision_session(
        request,
        session_token,
        settings.discord_vision_token,
        idempotency_key,
        collector_version,
        requested_model,
    )
    contribution_enabled=bool(contribution_terms)
    if contribution_enabled and contribution_terms != CONTRIBUTION_TERMS_VERSION:
        raise HTTPException(428,"Current Krea2 prompt-contribution terms must be accepted in BetterDiscord.")
    diagnostics_enabled=bool(diagnostic_terms)
    if diagnostics_enabled and diagnostic_terms != DIAGNOSTIC_TERMS_VERSION:
        raise HTTPException(428,"Current Krea2 failure-diagnostic terms must be accepted in BetterDiscord.")
    diagnostic_username=" ".join(diagnostic_username.split())
    if diagnostics_enabled and (not diagnostic_username or len(diagnostic_username)>80):
        raise HTTPException(422,"A current Discord username is required for opt-in failure diagnostics.")
    active_job_id=None
    image_digest=""
    original_filename=image.filename or ""
    work=None
    path=None
    try:
        requested_guidance=" ".join(guidance.split())
        requested_analysis_profile=analysis_profile.strip().casefold()
        if requested_analysis_profile not in {"fast","maximum","v2"}:
            raise HTTPException(422,"Vision analysis profile must be fast, maximum, or v2.")
        requested_prompt_count=int(prompt_count)
        if requested_prompt_count not in {1,3}:
            raise HTTPException(422,"Vision prompt count must be one or three.")
        requested_dataset_guidance=strict_form_flag(dataset_guidance,"dataset_guidance")
        try:
            requested_feedback_context=parse_feedback_context(
                feedback_context,
                enabled=requested_dataset_guidance,
            )
        except ValueError as exc:
            raise HTTPException(422,str(exc)) from exc
        if len(requested_guidance)>600:
            raise HTTPException(422,"Vision guidance exceeds 600 characters.")
        work,path,digest=await prepared_upload(image)
        image_digest=digest
        requested_job_id=job_id.strip().lower()
        if requested_job_id:
            try:
                active_job_id=discord_jobs.create(
                    digest,
                    original_filename,
                    model=requested_model,
                    job_id=requested_job_id,
                )
            except ValueError as exc:
                raise HTTPException(422,str(exc)) from exc
            except Exception as exc:
                raise HTTPException(409,"Discord Vision job ID is already in use.") from exc
        else:
            active_job_id=track_job(
                discord_jobs.create,
                digest,
                original_filename,
                model=requested_model,
            )
        def progress(status:str,stage:str,queue_ahead:int=0):
            if active_job_id and not discord_jobs.is_cancel_requested(active_job_id):
                track_job(
                    discord_jobs.update,
                    active_job_id,
                    status=status,
                    stage=stage,
                    queue_ahead=queue_ahead,
                )
        progress.is_cancelled=lambda: bool(
            active_job_id and discord_jobs.is_cancel_requested(active_job_id)
        )
        describe_kwargs={
            "dataset_guidance":requested_dataset_guidance,
            "feedback_context":requested_feedback_context,
            "analysis_profile":requested_analysis_profile,
            "prompt_variant_count":requested_prompt_count,
        }
        if vision_session.remote_access is not None:
            describe_kwargs["remote_access"]=vision_session.remote_access
        result=await run_in_threadpool(
            discord_vision.describe,
            path,
            progress,
            requested_model,
            requested_guidance,
            **describe_kwargs,
        )
        if contribution_enabled:
            try:
                if krea2_contributor is None:
                    raise Krea2ContributionError("Online Krea2 contribution provenance is not configured.")
                progress("running",f"Submitting {len(result.prompt_variants)} prompt{'s' if len(result.prompt_variants) != 1 else ''} to the online Krea2 dataset",0)
                await run_in_threadpool(krea2_contributor.submit,result)
            except Krea2ContributionError as exc:
                # Dataset contribution is an optional, disclosed side effect. A
                # temporary online outage must never discard an otherwise valid
                # local prompt or turn a completed Vision request into HTTP 503.
                log.warning(
                    "online Krea2 prompt contribution deferred job=%s model=%s image_sha256=%s reason=%s",
                    active_job_id or "untracked",
                    requested_model,
                    image_digest or "unavailable",
                    exc,
                )
                progress("running","Prompt ready; online Krea2 contribution is temporarily unavailable",0)
        if active_job_id:
            if discord_jobs.is_cancel_requested(active_job_id):
                raise DiscordVisionCancelled("The Discord Vision job was cancelled.")
            reproducibility_method=getattr(discord_vision,"reproducibility_for",None)
            reproducibility=(
                track_job(
                    reproducibility_method,
                    requested_model,
                    result.dataset_guidance,
                    requested_analysis_profile,
                )
                if callable(reproducibility_method)
                else None
            )
            if isinstance(reproducibility,dict):
                reproducibility["prompt_variant_count"]=len(result.prompt_variants)
                if isinstance(result.pose_check,dict):
                    # This is a bounded support ledger, not raw model evidence:
                    # no pixels, prompts, Discord identity, URLs, or paths.
                    reproducibility["pose_check"]=result.pose_check
                track_job(discord_jobs.set_reproducibility,active_job_id,reproducibility)
            track_job(
                discord_jobs.complete,
                active_job_id,
                prompt=result.prompt,
                prompt_variants=result.prompt_variants,
                model=result.model,
                prompt_words=result.prompt_words,
            )
        return result
    except HTTPException: raise
    except DiscordVisionCancelled as exc:
        if active_job_id:
            track_job(discord_jobs.cancel,active_job_id)
        raise HTTPException(409,"Discord Vision job was cancelled.") from exc
    except DiscordVisionDatasetUnavailable as exc:
        schedule_operational_error(event_id=active_job_id,model_id=requested_model,plugin_version=collector_version,error_code="dataset_guidance_unavailable",error_message=str(exc),stage="Selecting eight Krea2 writing-style examples")
        if vision_session.remote_access is not None:
            schedule_discord_error_report(event_id=active_job_id,model_id=requested_model,plugin_version=collector_version,error_code="dataset_guidance_unavailable",error_message=str(exc),stage="Selecting eight Krea2 writing-style examples",technical_trace=exception_trace(exc),license_id=vision_session.remote_access.license_id,license_token=vision_session.remote_access.license_token)
        schedule_failure_diagnostic(krea2_diagnostic_reporter,path,active_job_id,diagnostics_enabled,diagnostic_username,requested_model,collector_version,"dataset_guidance_unavailable","Krea2 dataset guidance is unavailable.","Selecting eight Krea2 writing-style examples",exc)
        log.warning("Krea2 dataset guidance was requested but unavailable (%s)",exc)
        if active_job_id:
            track_job(
                discord_jobs.update,
                active_job_id,
                status="error",
                stage="Krea2 dataset guidance could not select eight examples",
                public_error="Krea2 dataset guidance is unavailable. Retry or turn it off.",
            )
        raise HTTPException(
            503,
            "Krea2 dataset guidance is unavailable. Retry or turn it off.",
        ) from exc
    except DiscordVisionSafetyRejected as exc:
        schedule_operational_error(event_id=active_job_id,model_id=requested_model,plugin_version=collector_version,error_code="adult_status_unconfirmed",error_message=str(exc),stage="Rechecking adult-only status")
        schedule_failure_diagnostic(krea2_diagnostic_reporter,path,active_job_id,diagnostics_enabled,diagnostic_username,requested_model,collector_version,"adult_status_unconfirmed","Adult-only status could not be confirmed after an independent recheck.","Rechecking adult-only status",exc)
        log.info("discord vision stopped by repeated age-safety result (%s)",exc)
        if active_job_id:
            track_job(
                discord_jobs.update,
                active_job_id,
                status="rejected",
                stage="Adult-only status was not confirmed after an independent recheck",
                public_error="Vision stopped because adult-only status could not be confirmed after rechecking the image.",
            )
        raise HTTPException(422,"Adult-only status could not be confirmed after rechecking the image.") from exc
    except DiscordVisionRejected as exc:
        schedule_operational_error(event_id=active_job_id,model_id=requested_model,plugin_version=collector_version,error_code="output_validation_failed",error_message=str(exc),stage="Validating the audited final prompt set")
        if vision_session.remote_access is not None:
            schedule_discord_error_report(event_id=active_job_id,model_id=requested_model,plugin_version=collector_version,error_code="output_validation_failed",error_message=str(exc),stage="Validating the audited final prompt set",technical_trace=exception_trace(exc),license_id=vision_session.remote_access.license_id,license_token=vision_session.remote_access.license_token)
        schedule_failure_diagnostic(krea2_diagnostic_reporter,path,active_job_id,diagnostics_enabled,diagnostic_username,requested_model,collector_version,"output_validation_failed","Heretic output remained unusable after automatic repair.","Validating the audited final prompt set",exc)
        log.warning(
            "heretic output remained unusable after repair job=%s model=%s image_sha256=%s reason=%s",
            active_job_id or "untracked",
            requested_model,
            image_digest or "unavailable",
            exc,
        )
        if active_job_id:
            track_job(
                discord_jobs.update,
                active_job_id,
                status="error",
                stage="Heretic output validation failed after an automatic repair attempt",
                public_error="Heretic returned unusable output twice; no prompt was saved.",
            )
        raise HTTPException(502,"Heretic returned unusable output twice; no prompt was saved.") from exc
    except (DiscordVisionBackendError,ForgeHandoffError,SharedGpuUnavailableError) as exc:
        schedule_operational_error(event_id=active_job_id,model_id=requested_model,plugin_version=collector_version,error_code="vision_backend_unavailable",error_message=str(exc) or type(exc).__name__,stage="Acquiring or running the selected Vision backend")
        if vision_session.remote_access is not None:
            schedule_discord_error_report(event_id=active_job_id,model_id=requested_model,plugin_version=collector_version,error_code="vision_backend_unavailable",error_message=str(exc) or type(exc).__name__,stage="Acquiring or running the selected Vision backend",technical_trace=exception_trace(exc),license_id=vision_session.remote_access.license_id,license_token=vision_session.remote_access.license_token)
        schedule_failure_diagnostic(krea2_diagnostic_reporter,path,active_job_id,diagnostics_enabled,diagnostic_username,requested_model,collector_version,"vision_backend_unavailable",str(exc) or type(exc).__name__,"Acquiring or running the selected Vision backend",exc)
        cause=exc.__cause__
        failure_stage,public_error,http_detail=backend_public_failure(exc,requested_model)
        log.error(
            "discord vision unavailable (%s: %s; cause=%s: %s)",
            type(exc).__name__,
            exc,
            type(cause).__name__ if cause is not None else "none",
            cause or "none",
        )
        if active_job_id:
            track_job(
                discord_jobs.update,
                active_job_id,
                status="error",
                stage=failure_stage,
                public_error=public_error,
            )
        raise HTTPException(503,http_detail) from exc
    except Exception as exc:
        schedule_operational_error(event_id=active_job_id,model_id=requested_model,plugin_version=collector_version,error_code="vision_internal_error",error_message=f"{type(exc).__name__}: {exc}",stage="Running the local Vision pipeline")
        if vision_session.remote_access is not None:
            schedule_discord_error_report(event_id=active_job_id,model_id=requested_model,plugin_version=collector_version,error_code="vision_internal_error",error_message=f"{type(exc).__name__}: {exc}",stage="Running the local Vision pipeline",technical_trace=exception_trace(exc),license_id=vision_session.remote_access.license_id,license_token=vision_session.remote_access.license_token)
        schedule_failure_diagnostic(krea2_diagnostic_reporter,path,active_job_id,diagnostics_enabled,diagnostic_username,requested_model,collector_version,"vision_internal_error",f"{type(exc).__name__}: {exc}","Running the local Vision pipeline",exc)
        log.error("discord vision failed (%s)",type(exc).__name__)
        if active_job_id:
            track_job(
                discord_jobs.update,
                active_job_id,
                status="error",
                stage="The local Vision pipeline failed safely",
                public_error="The local Vision pipeline failed safely.",
            )
        raise HTTPException(500,"Local vision pipeline failed safely.") from exc
    finally:
        if work is not None:
            work.cleanup()


@router.post("/v2-describe",response_model=DiscordDescribeResponse)
async def v2_describe(
    request:Request,
    response:Response,
    image:UploadFile=File(...),
    model:str=Form(""),
    guidance:str=Form(""),
    prompt_count:int=Form(1),
):
    """Private loopback entrypoint for the merged Studio's V2 experiment.

    This deliberately supports installed local llama.cpp models only. The paid
    Serverless path remains bound to BetterDiscord's one-use licensed session,
    so adding the tab cannot reserve credits or weaken that boundary.
    """

    require_loopback(request,"V2 Direct Fidelity accepts literal loopback clients only.")
    if not suite_updates.accepting_new_jobs():
        raise HTTPException(503,"A verified KREA2 Vision Suite update is being installed. Retry shortly.")
    requested_guidance=" ".join(guidance.split())
    if len(requested_guidance)>600:
        raise HTTPException(422,"V2 emphasis exceeds 600 characters.")
    requested_prompt_count=int(prompt_count)
    if requested_prompt_count not in {1,3}:
        raise HTTPException(422,"V2 prompt count must be one or three.")
    local_models={
        spec.public_id
        for spec in available_model_specs(settings)
        if spec.backend=="llama_cpp" and spec.public_id in HERETIC_MODEL_IDS
    }
    requested_model=model.strip() or settings.model
    if requested_model not in local_models:
        raise HTTPException(422,"Choose an installed local llama.cpp Vision model for V2.")
    work=None
    try:
        work,path,_=await prepared_upload(image)
        result=await run_in_threadpool(
            discord_vision.describe,
            path,
            None,
            requested_model,
            requested_guidance,
            analysis_profile="v2",
            prompt_variant_count=requested_prompt_count,
        )
        response.headers["Cache-Control"]="no-store"
        return result
    except HTTPException:
        raise
    except DiscordVisionSafetyRejected as exc:
        raise HTTPException(422,"Adult-only status could not be confirmed from the image.") from exc
    except DiscordVisionRejected as exc:
        log.warning("V2 Direct Fidelity output remained unusable after bounded recovery (%s)",exc)
        raise HTTPException(502,"V2 returned unusable output; no prompt was saved.") from exc
    except (DiscordVisionBackendError,ForgeHandoffError,SharedGpuUnavailableError) as exc:
        _,_,detail=backend_public_failure(exc,requested_model)
        raise HTTPException(503,detail) from exc
    except Exception as exc:
        log.exception("V2 Direct Fidelity failed")
        raise HTTPException(500,"V2 Direct Fidelity failed safely.") from exc
    finally:
        if work is not None:
            work.cleanup()

@router.post("/analyze")
async def analyze(image:UploadFile=File(...), controls:str=Form("{}"), prior:str=Form(""), model:str=Form("")):
    try: parsed=PromptControls.model_validate_json(controls)
    except Exception as exc: raise HTTPException(422,"Invalid Studio controls.") from exc
    try: prior_state=StudioState.model_validate_json(prior) if prior else None
    except Exception as exc: raise HTTPException(422,"Invalid prior Studio state.") from exc
    try:
        work,path,digest=await prepared_upload(image)
        selected_model=model.strip()
        installed={spec.public_id for spec in available_model_specs(settings)}
        if selected_model and selected_model not in installed:
            raise HTTPException(422,"Selected Vision model is not installed or is no longer available.")
        try: return pipeline.analyze(path,digest,parsed,prior=prior_state,model=selected_model or None).model_dump()
        finally: work.cleanup()
    except HTTPException: raise
    except Exception as exc: log.exception("analysis failed"); readable_error(exc)

class RecomposeRequest(BaseModel): state: StudioState; controls: PromptControls; rewrite: str="Rewrite the prompt while respecting every lock."
@router.post("/recompose")
def recompose(payload:RecomposeRequest):
    try: return pipeline.recompose(payload.state,payload.controls,payload.rewrite).model_dump()
    except Exception as exc: log.exception("recompose failed"); readable_error(exc)

@router.post("/evaluate")
async def evaluate(image:UploadFile=File(...), prompt:str=Form(...)):
    try:
        work,path,_=await prepared_upload(image)
        try: return pipeline.evaluate(path,prompt).model_dump()
        finally: work.cleanup()
    except HTTPException: raise
    except Exception as exc: log.exception("evaluation failed"); readable_error(exc)

@router.get("/history")
def history(): return pipeline.history.list()
@router.get("/presets")
def preset_list(): return presets.list()
class PresetRequest(BaseModel): name:str; controls:dict
@router.post("/presets")
def preset_save(request:PresetRequest):
    if not request.name.strip() or len(request.name)>80: raise HTTPException(422,"Preset needs a name of 1-80 characters.")
    return presets.save(request.name.strip(),request.controls)
@router.get("/settings")
def public_settings(): return {"backend":settings.backend,"model":settings.model,"context_length":settings.context_length,"privacy_mode":settings.privacy_mode,"queue_enabled":settings.queue_enabled}

@router.get("/models")
def public_models():
    return {"models":public_model_statuses(settings)}

@router.get("/remote-health")
def public_remote_health(request:Request,response:Response):
    require_loopback(request,"Remote Vision capacity is available on literal loopback only.")
    response.headers["Cache-Control"]="no-store"
    if not settings.remote_gateway_url:
        return {
            "ok":True,
            "configured":False,
            "remote_ready":False,
            "remote_cold_start_eligible":False,
            "remote_status":"Online API is not configured.",
        }
    try:
        return fetch_remote_gateway_health(
            settings.remote_gateway_url,
            origin_ip=settings.remote_gateway_origin_ip,
        )
    except RemoteGatewayProviderError as exc:
        return {
            "ok":True,
            "configured":True,
            "remote_ready":False,
            "remote_cold_start_eligible":False,
            "remote_status":str(exc),
        }

@router.get("/discord-models")
def public_discord_models(request:Request,response:Response):
    require_loopback(request,"Discord Vision model choices are available on literal loopback only.")
    response.headers["Cache-Control"]="no-store"
    telemetry_path=Path(settings.llama_cpp_telemetry_path).expanduser()
    if not telemetry_path.is_absolute(): telemetry_path=ROOT/telemetry_path
    telemetry=MeasuredPeakStore(telemetry_path)
    try: memory=query_gpu_memory()
    except GpuTelemetryError: memory=None
    specs={spec.public_id:spec for spec in available_model_specs(settings)}
    available=[]
    for public_item in public_model_statuses(settings):
        if public_item["public_id"] not in HERETIC_MODEL_IDS: continue
        item=dict(public_item)
        active_context=max(512,min(settings.context_length,int(item.get("context_cap") or settings.context_length)))
        measured=telemetry.get(item["public_id"],context_length=active_context) or {}
        peak=max(0,int(measured.get("peak_delta_mb") or 0))
        remote=not bool(item.get("local_gpu"))
        reserve=0 if remote else max(0,settings.llama_cpp_vram_headroom_mb)
        estimate=max(0,int(item.get("estimated_vram_mb") or 0))
        spec=specs.get(item["public_id"])
        requirements=(
            gpu_capacity_requirements(pipeline._active_settings(spec),spec,peak)
            if not remote and spec is not None
            else {}
        )
        required=0 if remote else int(requirements.get("required_vram_mb") or max(estimate,peak)+reserve)
        item.update({
            "last_measured_peak_mb":peak,
            "safety_reserve_mb":reserve,
            "admission_tolerance_mb":0 if remote else VRAM_ADMISSION_JITTER_MB,
            "admission_required_mb":required,
            "full_gpu_required_mb":0 if remote else int(requirements.get("full_gpu_required_vram_mb") or required),
            "adaptive_gpu_fit":False if remote else bool(requirements.get("adaptive_gpu_fit")),
            "runtime_fit_target_mb":None if remote else requirements.get("runtime_fit_target_mb"),
            "minimum_gpu_allocation_mb":0 if remote else int(requirements.get("minimum_gpu_allocation_mb") or max(estimate,peak)),
            "available_vram_mb":None if remote else memory.free_mb if memory else None,
            "total_vram_mb":None if remote else memory.total_mb if memory else None,
            "allocation_target_mb":0 if remote else max(0,settings.llama_cpp_model_allocation_target_mb),
            "over_allocation_target":False if remote else bool(settings.llama_cpp_model_allocation_target_mb and estimate>settings.llama_cpp_model_allocation_target_mb),
            "admission_passes_now":True if remote else bool(memory and memory.free_mb+VRAM_ADMISSION_JITTER_MB>=required),
            "execution":"remote_serverless" if remote else "local_shared_gpu",
        })
        available.append(item)
    available.append({
        "public_id":LEGACY_MODEL_ID,
        "label":f"Legacy Ollama hybrid — {MODEL_LABEL}",
        "backend":"ollama",
        "local_gpu":True,
        "context_cap":32768,
        "max_output_cap":4096,
        "estimated_vram_mb":0,
        "last_measured_peak_mb":0,
        "safety_reserve_mb":max(0,settings.llama_cpp_vram_headroom_mb),
        "admission_tolerance_mb":VRAM_ADMISSION_JITTER_MB,
        "admission_required_mb":0,
        "available_vram_mb":memory.free_mb if memory else None,
        "total_vram_mb":memory.total_mb if memory else None,
        "allocation_target_mb":max(0,settings.llama_cpp_model_allocation_target_mb),
        "over_allocation_target":False,
        "admission_passes_now":True,
    })
    preferred=settings.model if settings.model in {item["public_id"] for item in available} else LEGACY_MODEL_ID
    return {"preferred":preferred,"models":available}

class ModelInstallRequest(BaseModel):
    model:str

@router.post("/discord-models/install")
def install_discord_model(
    payload:ModelInstallRequest,
    request:Request,
    token:Annotated[str|None,Header(alias="X-Krea2-Vision-Token")]=None,
):
    require_discord_vision_auth(request,token,settings.discord_vision_token)
    try: return model_downloads.start(payload.model.strip())
    except ModelDownloadBusy as exc: raise HTTPException(409,str(exc)) from exc
    except ModelDownloadError as exc: raise HTTPException(422,str(exc)) from exc

@router.get("/discord-models/install/{model_id}")
def discord_model_install_status(
    model_id:str,
    request:Request,
    response:Response,
    token:Annotated[str|None,Header(alias="X-Krea2-Vision-Token")]=None,
):
    require_discord_vision_auth(request,token,settings.discord_vision_token)
    response.headers["Cache-Control"]="no-store"
    try: return model_downloads.status(model_id.strip())
    except ModelDownloadError as exc: raise HTTPException(404,str(exc)) from exc

@router.get("/suite-update")
def check_suite_update(
    request:Request,
    response:Response,
    token:Annotated[str|None,Header(alias="X-Krea2-Vision-Token")]=None,
):
    require_discord_vision_auth(request,token,settings.discord_vision_token)
    response.headers["Cache-Control"]="no-store"
    try: return suite_updates.check()
    except SuiteUpdateError as exc: raise HTTPException(502,str(exc)) from exc

@router.get("/suite-update/status")
def suite_update_status(
    request:Request,
    response:Response,
    token:Annotated[str|None,Header(alias="X-Krea2-Vision-Token")]=None,
):
    require_discord_vision_auth(request,token,settings.discord_vision_token)
    response.headers["Cache-Control"]="no-store"
    return suite_updates.status()

@router.post("/suite-update/install")
def install_suite_update(
    request:Request,
    response:Response,
    token:Annotated[str|None,Header(alias="X-Krea2-Vision-Token")]=None,
):
    require_discord_vision_auth(request,token,settings.discord_vision_token)
    response.headers["Cache-Control"]="no-store"
    try: return suite_updates.start()
    except SuiteUpdateBusy as exc: raise HTTPException(409,str(exc)) from exc
    except SuiteUpdateError as exc: raise HTTPException(502,str(exc)) from exc
