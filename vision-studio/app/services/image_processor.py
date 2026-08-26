from __future__ import annotations
import hashlib, io
from pathlib import Path
from PIL import Image, ImageFile, ImageOps
ImageFile.LOAD_TRUNCATED_IMAGES = False
Image.MAX_IMAGE_PIXELS = 60_000_000
ALLOWED={".png",".jpg",".jpeg",".webp"}

class ImageProcessor:
    def __init__(self,max_bytes,max_pixels,max_side): self.max_bytes,self.max_pixels,self.max_side=max_bytes,max_pixels,max_side
    def prepare(self, source: Path, work: Path) -> tuple[Path,str]:
        if source.suffix.lower() not in ALLOWED: raise RuntimeError("Upload PNG, JPG/JPEG, or WEBP only.")
        if source.stat().st_size > self.max_bytes: raise RuntimeError("Image exceeds the configured upload limit.")
        digest=hashlib.sha256(source.read_bytes()).hexdigest()
        try:
            with Image.open(source) as image:
                image.verify()
            with Image.open(source) as image:
                if image.format not in {"PNG","JPEG","WEBP"}: raise RuntimeError("File contents are not a supported image format.")
                if image.width*image.height > self.max_pixels: raise RuntimeError("Image has too many pixels for safe decoding.")
                normalized=ImageOps.exif_transpose(image).convert("RGB"); normalized.thumbnail((self.max_side,self.max_side),Image.Resampling.LANCZOS)
                result=work/"analysis.jpg"; normalized.save(result,"JPEG",quality=94,optimize=True); return result,digest
        except (OSError,Image.DecompressionBombError) as exc: raise RuntimeError("Image could not be safely decoded.") from exc
    def crops(self, image_path: Path, work: Path) -> list[tuple[str,Path]]:
        with Image.open(image_path) as image:
            w,h=image.size; regions=[("upper face and hair",(0,0,w,int(h*.48))), ("torso, clothing and hands",(0,int(h*.23),w,int(h*.80))), ("hips, groin and upper legs",(0,int(h*.30),w,int(h*.82)))]
            result=[]
            for label,box in regions:
                crop=image.crop(box).convert("RGB")
                if max(crop.size) < 1024:
                    scale=min(4.0,1024/max(crop.size))
                    crop=crop.resize((max(1,round(crop.width*scale)),max(1,round(crop.height*scale))),Image.Resampling.LANCZOS)
                else:
                    crop.thumbnail((1536,1536),Image.Resampling.LANCZOS)
                path=work/f"crop_{len(result)}.jpg"; crop.save(path,"JPEG",quality=94); result.append((label,path))
            return result
