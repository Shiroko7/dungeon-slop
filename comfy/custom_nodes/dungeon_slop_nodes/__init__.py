"""Dungeon Slop helper nodes for ComfyUI.

WrapDecode: decode a latent as a torus. The latent is padded with copies of its
own opposite edges, decoded with the ordinary VAE, then cropped back, so the
decoder sees wrapped context at every border and the image tiles without a seam.
It never copies or patches the VAE, unlike circular-padding VAE wrappers, so it
is safe to share one loaded VAE between tiling and ordinary workflows.
"""
import torch


def _wrap(t: torch.Tensor, pad: int, dim: int) -> torch.Tensor:
    size = t.shape[dim]
    pad = min(pad, size)
    head = t.narrow(dim, 0, pad)
    tail = t.narrow(dim, size - pad, pad)
    return torch.cat([tail, t, head], dim=dim)


class WrapDecode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
                "vae": ("VAE",),
                "tiling": (["enable", "x_only", "y_only"],),
                "pad": ("INT", {"default": 8, "min": 1, "max": 64,
                                "tooltip": "Latent cells of wrapped context added on each side."}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "decode"
    CATEGORY = "latent"

    def decode(self, samples, vae, tiling, pad):
        z = samples["samples"]
        h, w = z.shape[-2], z.shape[-1]
        px = pad if tiling in ("enable", "x_only") else 0
        py = pad if tiling in ("enable", "y_only") else 0
        if px:
            z = _wrap(z, px, z.dim() - 1)
        if py:
            z = _wrap(z, py, z.dim() - 2)
        img = vae.decode(z)
        if img.dim() == 5:  # video-style VAEs return [B, T, H, W, C]
            img = img.reshape(-1, *img.shape[-3:])
        H, W = img.shape[1], img.shape[2]
        sy = H // (h + 2 * py)
        sx = W // (w + 2 * px)
        return (img[:, py * sy: py * sy + h * sy, px * sx: px * sx + w * sx, :].contiguous(),)


NODE_CLASS_MAPPINGS = {"DslopWrapDecode": WrapDecode}
NODE_DISPLAY_NAME_MAPPINGS = {"DslopWrapDecode": "Wrap Decode (seamless, Dungeon Slop)"}
