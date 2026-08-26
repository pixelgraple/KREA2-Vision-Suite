from __future__ import annotations
import json, tempfile
from pathlib import Path
import gradio as gr
from .config import ROOT, settings
from .schemas.prompt import PromptControls, StudioState
from .services.history import PresetStore
from .services.gpu_telemetry import GpuTelemetryError, MeasuredPeakStore, query_gpu_memory
from .services.image_processor import ImageProcessor
from .services.model_catalog import public_model_statuses, resolve_model
from .services.pipeline import StudioPipeline, VRAM_ADMISSION_JITTER_MB

pipeline=StudioPipeline(settings); presets=PresetStore(ROOT)
telemetry_path=Path(settings.llama_cpp_telemetry_path).expanduser()
if not telemetry_path.is_absolute(): telemetry_path=ROOT/telemetry_path
peak_store=MeasuredPeakStore(telemetry_path)
LOCKS=["face","hair","expression","pose","outfit","accessories","environment","composition","lighting","color_grade"]
SLIDERS=[("reference_fidelity","Reference Fidelity",90),("photorealism","Photorealism",85),("cinematic_look","Cinematic Look",45),("skin_texture","Skin Texture",80),("environment_detail","Environment Detail",75),("clothing_detail","Clothing Detail",90),("pose_detail","Pose Detail",90),("lighting_detail","Lighting Detail",85),("color_grade_detail","Color Grade Detail",80),("camera_detail","Camera Detail",70)]

def format_vram(mb): return f"{int(mb):,} MiB ({int(mb)/1024:.1f} GiB)"

def model_options(current_model=None):
    statuses=public_model_statuses(settings)
    try: memory=query_gpu_memory()
    except GpuTelemetryError: memory=None
    available={item["public_id"]:item for item in statuses}
    selected=current_model if current_model in available else None
    if selected is None:
        try: selected=resolve_model(current_model or settings.model,settings).public_id
        except Exception: selected=None
    if selected not in available: selected=statuses[0]["public_id"] if statuses else None
    choices=[]
    for item in statuses:
        active_context=max(512,min(settings.context_length,int(item.get("context_cap") or settings.context_length)))
        record=peak_store.get(item["public_id"],context_length=active_context) or {}
        measured=max(0,int(record.get("peak_delta_mb") or 0))
        reserve=max(0,settings.llama_cpp_vram_headroom_mb)
        required=max(int(item["estimated_vram_mb"]),measured)+reserve
        target=max(0,settings.llama_cpp_model_allocation_target_mb)
        provider="llama.cpp CUDA" if item["backend"]=="llama_cpp" else "Ollama"
        measured_text=format_vram(measured) if measured else "not measured"
        free_text=format_vram(memory.free_mb) if memory else "unavailable"
        target_text=f" · ⚠ over {format_vram(target)} target" if target and int(item["estimated_vram_mb"])>target else ""
        label=(f"{provider} · {item['label']} · estimate {format_vram(item['estimated_vram_mb'])} · "
               f"measured {measured_text} · reserve {format_vram(reserve)} · "
               f"admission {format_vram(required)} · available {free_text}{target_text}")
        choices.append((label,item["public_id"]))
    if selected is None:
        detail="No verified local Vision model is available. Refresh after installing Ollama models or verified llama.cpp artifacts."
    else:
        item=available[selected]
        active_context=max(512,min(settings.context_length,int(item.get("context_cap") or settings.context_length)))
        record=peak_store.get(selected,context_length=active_context) or {}
        measured=max(0,int(record.get("peak_delta_mb") or 0))
        reserve=max(0,settings.llama_cpp_vram_headroom_mb)
        target=max(0,settings.llama_cpp_model_allocation_target_mb)
        required=max(int(item["estimated_vram_mb"]),measured)+reserve
        provider="llama.cpp CUDA" if item["backend"]=="llama_cpp" else "Ollama"
        measured_text=format_vram(measured) if measured else "not measured yet"
        if memory is None:
            verdict="Current free VRAM is unavailable. The run will fail closed if the post-handoff check is unavailable."
        elif memory.free_mb + VRAM_ADMISSION_JITTER_MB < required:
            verdict=f"⚠ Current free VRAM ({format_vram(memory.free_mb)}) is below the conservative requirement ({format_vram(required)})."
        else:
            verdict=f"✓ Current free VRAM is {format_vram(memory.free_mb)}; conservative requirement is {format_vram(required)}."
        if target and int(item["estimated_vram_mb"])>target:
            target_verdict=(f"⚠ **Allocation target warning:** this model's {format_vram(item['estimated_vram_mb'])} estimate exceeds "
                            f"the {format_vram(target)} (12 GiB) model-allocation target. It remains selectable; "
                            "the target is advisory and the authoritative post-Forge-unload admission check decides whether it may run.")
        else:
            target_verdict=f"✓ Estimated model allocation is within the {format_vram(target)} (12 GiB) target." if target else ""
        free_text=format_vram(memory.free_mb) if memory else "unavailable"
        detail=(f"**{provider} · {item['label']}**\n\n"
                f"- Current available VRAM: **{free_text}**\n"
                f"- Estimated model allocation: **{format_vram(item['estimated_vram_mb'])}**\n"
                f"- Last measured peak: **{measured_text}**\n"
                f"- Separate safety reserve: **{format_vram(reserve)}**\n"
                f"- Admission requirement: **{format_vram(required)}** = max(estimate, measured peak) + reserve\n\n"
                f"- NVML observation tolerance: **{format_vram(VRAM_ADMISSION_JITTER_MB)}** (the 4 GiB reserve remains separately reported)\n\n"
                f"{target_verdict}\n\n{verdict} This pre-queue reading is advisory because Forge may currently occupy VRAM. "
                "Studio rechecks only after FIFO acquisition and verified Forge unload.")
    return choices,selected,detail,len(statuses)

model_choices,initial_model,initial_vram_status,_=model_options()

def controls_from(values):
    mode,detail,content,realism,deep,wd14,negative,instructions,*rest=values
    slider_values=rest[:len(SLIDERS)]; locks=rest[len(SLIDERS):]
    data={"mode":mode,"detail":detail,"content_mode":content,"realism":realism,"deep_inspection":deep,"use_wd14":wd14,"generate_negative":negative,"additional_instructions":instructions}
    data.update({name:value for (name,_,_),value in zip(SLIDERS,slider_values)})
    data["locks"]={name:value for name,value in zip(LOCKS,locks)}
    return PromptControls.model_validate(data)

def analysis_values(state: StudioState):
    subject=state.merged.primary_subject or {}
    values=[state.merged.subjects,subject.get("face",{}),subject.get("hair",{}),subject.get("expression",{}),subject.get("pose",{}),subject.get("wardrobe",[]),subject.get("accessories",[]),state.merged.environment,state.merged.composition,state.merged.lighting,state.merged.textures,state.merged.color_grade,state.merged.uncertainties]
    return [json.dumps(value,ensure_ascii=False,indent=2) for value in values]

def outputs(state: StudioState, status="Complete — shared GPU queue released."):
    return (state.model_dump(),state.prompt.final_prompt,state.prompt.negative_prompt,*analysis_values(state),state.merged.model_dump(),state.debug,status)

def with_image(image_path, model_name, *values, prior=None, progress=gr.Progress()):
    if not image_path: raise gr.Error("Upload a PNG, JPG/JPEG, or WEBP reference image first.")
    try:
        selected=resolve_model(model_name,settings)
        controls=controls_from(values)
        with tempfile.TemporaryDirectory(prefix="krea2-studio-") as directory:
            source=Path(image_path); copy=Path(directory)/("source"+source.suffix.lower()); copy.write_bytes(source.read_bytes())
            prepared,digest=ImageProcessor(settings.max_upload_mb*1024*1024,settings.max_image_pixels,settings.max_image_side).prepare(copy,Path(directory))
            state=pipeline.analyze(prepared,digest,controls,progress=lambda stage:progress(0,desc=stage),prior=StudioState.model_validate(prior) if prior else None,model=selected.public_id)
            return outputs(state)
    except Exception as exc: raise gr.Error(str(exc)) from exc

def recompose(state_data, model_name, rewrite, final, negative, *values, progress=gr.Progress()):
    if not state_data: raise gr.Error("Analyze an image before rewriting it.")
    try:
        state=StudioState.model_validate(state_data); state.prompt.final_prompt=final; state.prompt.negative_prompt=negative
        state=pipeline.recompose(state,controls_from(values),rewrite,progress=lambda stage:progress(0,desc=stage),model=model_name); return outputs(state)
    except Exception as exc: raise gr.Error(str(exc)) from exc

def compare_prompt(image_path, model_name, final_prompt, progress=gr.Progress()):
    if not image_path or not final_prompt.strip(): raise gr.Error("Upload an image and generate a prompt before comparing.")
    try:
        with tempfile.TemporaryDirectory(prefix="krea2-studio-") as directory:
            source=Path(image_path); copy=Path(directory)/("source"+source.suffix.lower()); copy.write_bytes(source.read_bytes())
            prepared,_=ImageProcessor(settings.max_upload_mb*1024*1024,settings.max_image_pixels,settings.max_image_side).prepare(copy,Path(directory))
            score=pipeline.evaluate(prepared,final_prompt,progress=lambda stage:progress(0,desc=stage),model=model_name); return score.model_dump(),"Comparison complete. Use Apply Missing Details to incorporate only supported omissions."
    except Exception as exc: raise gr.Error(str(exc)) from exc

def apply_missing(state_data, evaluation, model_name, final, negative, *values, progress=gr.Progress()):
    omissions=(evaluation or {}).get("omissions",[]); return recompose(state_data,model_name,"Apply only these supported omissions: "+"; ".join(omissions),final,negative,*values,progress=progress)
def save_preset(name, *values):
    if not name.strip(): raise gr.Error("Enter a preset name.")
    all_items=presets.save(name.strip(),controls_from(values).model_dump()); return gr.update(choices=[item["name"] for item in all_items],value=name.strip()),"Preset saved locally."
def load_preset(name):
    selected=next((item for item in presets.list() if item["name"]==name),None)
    if not selected: return [gr.update() for _ in range(8+len(SLIDERS)+len(LOCKS))]
    c=PromptControls.model_validate(selected["controls"]); return [c.mode,c.detail,c.content_mode,c.realism,c.deep_inspection,c.use_wd14,c.generate_negative,c.additional_instructions,*[getattr(c,key) for key,_,_ in SLIDERS],*[c.locks.get(key,False) for key in LOCKS]]
def history_rows(): return [[item["id"],item["created"],item["model"],item["prompt"][:240]] for item in pipeline.history.list()]
def refresh_models(current_model):
    choices,selected,vram,count=model_options(current_model)
    message=f"{count} verified local Vision model(s) available." if count else "No verified local Vision model is available yet."
    return gr.update(choices=choices,value=selected),message,vram
def selected_model_status(model_name): return model_options(model_name)[2]

CSS="""body{background:#0b0e15}.gradio-container{max-width:1560px!important}.studio-hero{background:radial-gradient(circle at 15% 0,#4e327d,transparent 40%),#151222;border:1px solid #493475;border-radius:18px;padding:24px;margin-bottom:14px}.studio-hero h1{margin:0;color:#f4f1ff}.studio-hero p{color:#c7b8ec}.dashboard-link{display:inline-flex;margin-top:8px;padding:9px 13px;border:1px solid #7660bd;border-radius:9px;color:#f4f1ff!important;text-decoration:none!important;background:#2a2147}.dashboard-link:hover{background:#392a61}.stage{color:#9cf5e8}.vram-status{border:1px solid #39435b;border-radius:10px;padding:8px 12px;background:#111722}.prompt textarea{min-height:440px!important;font-size:15px!important;line-height:1.55}.small textarea{min-height:190px!important}.analysis textarea{min-height:160px!important}.control-card{border:1px solid #2e3650;border-radius:14px;padding:12px}"""

with gr.Blocks(title="KREA2 Vision Prompt Studio",theme=gr.themes.Base(primary_hue="violet",neutral_hue="slate"),css=CSS) as demo:
    gr.HTML("<div class='studio-hero'><p class='stage'>QWEN3-VL · FOUR-PASS VISUAL EVIDENCE PIPELINE</p><h1>KREA2 Vision Prompt Studio</h1><p>Objective analysis → visual critic → corrected evidence → KREA2 prompt writer. Local-first, queue-safe.</p><a class='dashboard-link' href='/discord-jobs' target='_blank' rel='noopener'>Open Discord Queue &amp; Prompts ↗</a></div>")
    state=gr.State(None); evaluation=gr.State({})
    with gr.Row():
        with gr.Column(scale=4,elem_classes="control-card"):
            image=gr.Image(label="Reference image",type="filepath",sources=["upload"],height=500)
            with gr.Row():
                interrogation_model=gr.Dropdown(choices=model_choices,value=initial_model,label="Interrogation model",info="Only locally verified Ollama or llama.cpp models are listed.",scale=4)
                refresh_model_list=gr.Button("Refresh models & VRAM",scale=2)
            vram_status=gr.Markdown(initial_vram_status,elem_classes="vram-status")
            analyze=gr.Button("Interrogate Image",variant="primary",size="lg")
            gr.Markdown("The default is automatic: exact-reference analysis, deep inspection, detailed prompt, and a negative prompt.")
            with gr.Accordion("Advanced analysis options",open=False):
                mode=gr.Dropdown(["Exact Reference","Photorealistic","Cinematic","Raw Photography","Amateur Photo","Smartphone Photo","Webcam","Fashion Photography","Editorial","Gothic","Cyberpunk","Post-Apocalyptic","Scene / Emo","Fantasy","Vintage","Soviet / Eastern European Film","Custom"],value="Exact Reference",label="Reference Analysis Mode")
                detail=gr.Radio(["Concise","Detailed","Extremely Detailed","Obsessive Detail"],value="Obsessive Detail",label="Prompt Detail")
                with gr.Row(): content=gr.Radio(["Auto","SFW","Adult / NSFW"],value="Auto",label="Content"); realism=gr.Radio(["OFF","NORMAL","STRONG","EXTREME"],value="NORMAL",label="Realism Enhancement")
                with gr.Row(): deep=gr.Checkbox(label="Deep Inspection",value=True); wd14=gr.Checkbox(label="Use WD14 Supplemental Analysis",value=False); negative_enabled=gr.Checkbox(label="Generate Negative",value=True)
                instructions=gr.Textbox(label="Additional Instructions",lines=5,placeholder="Optional: focus on pose, preserve an outfit, or request a color treatment.")
        with gr.Column(scale=8):
            status=gr.Markdown("Ready. Local Vision analysis will join the shared Forge GPU queue.")
            with gr.Tabs():
                with gr.Tab("Final Prompt"):
                    final=gr.Textbox(label="Final KREA2 Prompt",lines=18,elem_classes="prompt")
                    copy=gr.Button("Copy Prompt")
                    with gr.Accordion("Advanced prompt controls",open=False):
                        with gr.Row(): regen=gr.Button("Regenerate"); more=gr.Button("More Detailed"); less=gr.Button("Less Detailed"); realistic=gr.Button("More Realistic"); cinematic=gr.Button("More Cinematic"); raw=gr.Button("More Raw"); reinspect=gr.Button("Reinspect Image")
                        gr.Markdown("### Preservation locks")
                        locks=[]
                        with gr.Row():
                            for name in LOCKS: locks.append(gr.Checkbox(label="Lock "+name.replace("_"," ").title(),value=False))
                        gr.Markdown("### KREA2 prompt controls")
                        sliders=[]
                        for key,label,value in SLIDERS: sliders.append(gr.Slider(0,100,value=value,step=1,label=label))
                with gr.Tab("Analysis"):
                    labels=["Subject","Face","Hair","Expression","Pose","Clothing","Accessories","Environment","Composition","Lighting","Texture / Realism","Color Grade","Uncertainties"]; analysis_boxes=[]
                    for label in labels:
                        with gr.Accordion(label,open=label in {"Subject","Pose","Clothing"}): analysis_boxes.append(gr.Textbox(show_label=False,lines=8,elem_classes="analysis"))
                with gr.Tab("Negative Prompt"): negative=gr.Textbox(label="Editable negative prompt",lines=9,elem_classes="small"); copy_negative=gr.Button("Copy Negative")
                with gr.Tab("Raw Analysis"): raw_analysis=gr.JSON(label="Corrected structured evidence")
                with gr.Tab("Model Debug"): debug=gr.JSON(label="Pass outputs, timings, and token metrics")
                with gr.Tab("History & Presets"):
                    with gr.Row(): preset_name=gr.Textbox(label="Preset name"); save=gr.Button("Save preset"); preset_choice=gr.Dropdown(choices=[item["name"] for item in presets.list()],label="Load saved preset")
                    history=gr.Dataframe(headers=["ID","Unix time","Model","Prompt preview"],value=history_rows(),interactive=False)
            with gr.Row(): compare=gr.Button("Compare Prompt Against Reference"); apply=gr.Button("Apply Missing Details")
            score=gr.JSON(label="Reference comparison")

    control_inputs=[mode,detail,content,realism,deep,wd14,negative_enabled,instructions,*sliders,*locks]
    all_outputs=[state,final,negative,*analysis_boxes,raw_analysis,debug,status]
    analyze.click(with_image,[image,interrogation_model,*control_inputs],all_outputs).then(selected_model_status,[interrogation_model],[vram_status])
    refresh_model_list.click(refresh_models,[interrogation_model],[interrogation_model,status,vram_status])
    interrogation_model.change(selected_model_status,[interrogation_model],[vram_status])
    reinspect.click(lambda img,prior,model,*vals:with_image(img,model,*vals,prior=prior),[image,state,interrogation_model,*control_inputs],all_outputs)
    rewrite_inputs=[state,interrogation_model,final,negative,*control_inputs]
    for button,text in [(regen,"Rewrite with fresh wording while respecting every lock."),(more,"Increase supported visual specificity; do not add facts."),(less,"Be more concise while retaining defining reference details."),(realistic,"Increase only reference-supported photorealism and material behavior."),(cinematic,"Increase cinematic language only where the evidence supports it."),(raw,"Favor unretouched raw photography and reduce stylization where appropriate.")]:
        button.click(lambda st,model,final,negative,*vals,_text=text: recompose(st,model,_text,final,negative,*vals),rewrite_inputs,all_outputs)
    compare.click(compare_prompt,[image,interrogation_model,final],[evaluation,status]).then(lambda x:x,[evaluation],[score])
    apply.click(apply_missing,[state,evaluation,interrogation_model,final,negative,*control_inputs],all_outputs)
    save.click(save_preset,[preset_name,*control_inputs],[preset_choice,status])
    preset_choice.change(load_preset,[preset_choice],control_inputs)
    copy.click(None,[final],None,js="(value)=>navigator.clipboard.writeText(value||'')")
    copy_negative.click(None,[negative],None,js="(value)=>navigator.clipboard.writeText(value||'')")
