from __future__ import annotations
from ..schemas.prompt import PromptControls

def guidance(controls: PromptControls) -> str:
    """Evidence-led realism guidance; it never injects generic quality spam."""
    if controls.realism == "OFF": return "Do not add extra realism language beyond directly observed evidence."
    strength={"NORMAL":"Use a restrained, evidence-led realism pass.","STRONG":"Prioritize supported skin, hair, textile, lighting, and material behavior.","EXTREME":"Maximize supported photographic realism while avoiding generic quality claims."}[controls.realism]
    focus=[]
    if controls.skin_texture>=65: focus.append("natural skin texture, pores, subtle blemishes, and peach fuzz only if visible")
    if controls.photorealism>=65: focus.append("believable highlights, shadows, background separation, and material response")
    if controls.clothing_detail>=65: focus.append("fabric fibers, seams, folds, leather grain, or hardware only when evidenced")
    return strength+" Useful focus areas: "+("; ".join(focus) if focus else "only directly visible photographic characteristics")+"."
